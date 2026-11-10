"""Recover only MRT-owned Pupil recordings, preserving interrupted originals.

The advisory OS lock is released even after process death. Fragmented MP4 makes
closed fragments readable; the last fragment / unflushed samples can be lost.
Recovery is explicitly partial, never a claim of a lossless complete session.
"""

from bisect import bisect_right
import csv
import json
import math
import os
from pathlib import Path
import subprocess

from .pupil_csv import CSV_FIELDS
from .pupil_events import append_events, order_csv
from .pupil_metrics import journal_metrics
from .recording_communication import append_communications


class RecordingLease:
    def __init__(self, sidecar):
        path = Path(sidecar) / "recording.lock"
        if path.is_symlink():
            raise ValueError("Recording lock must not be a symbolic link")
        self.handle = path.open("a+b")
        if path.stat().st_size == 0:
            self.handle.write(b"0")
            self.handle.flush()
        self.handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise

    def close(self):
        if self.handle.closed:
            return
        if os.name == "nt":
            import msvcrt
            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        self.handle.close()


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".pending")
    if path.is_symlink() or temporary.is_symlink():
        raise ValueError("Recording metadata must not be a symbolic link")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, allow_nan=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_json(path):
    if path.is_symlink() or path.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Unsafe recording metadata")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Recording metadata must be an object")
    return value


def write_gaze_csv(spool, output, duration, stimuli, markers, source_model="PupilCore"):
    """Shared finalization/recovery mapping; ignore only a torn last journal line."""
    stimuli = sorted(stimuli or [(0.0, "")], key=lambda item: item[0])
    times = [item[0] for item in stimuli]
    writer = csv.DictWriter(output, fieldnames=CSV_FIELDS)
    writer.writeheader()
    counts = {"gazeRows": 0, "validGazeRows": 0, "gazeOutsideVideo": 0}
    for line in spool:
        if not line.endswith("\n"):
            break
        row = json.loads(line)
        timestamp = row["video_time_ms"]
        if 0 <= timestamp < duration * 1000:
            row["stimulus"] = stimuli[max(0, bisect_right(times, timestamp) - 1)][1]
            writer.writerow(row)
            counts["gazeRows"] += 1
            # Bit 0 denotes a valid recommended gaze, independently of pupil
            # measurements. Only old journals without a mask use the pupil flag.
            validity = row.get("recom_gaze_bit_mask", row.get("pupil_valid"))
            try:
                mask = int(validity or 0)
            except (TypeError, ValueError, OverflowError):
                mask = 0
            counts["validGazeRows"] += int(mask >= 0 and bool(mask & 1))
        else:
            counts["gazeOutsideVideo"] += 1
    for marker in markers:
        timestamp = marker["timestamp"]
        if not 0 <= timestamp < duration * 1000:
            continue
        row = dict.fromkeys(CSV_FIELDS, "")
        row.update(timestamp=timestamp, video_time_ms=timestamp, source_model=source_model,
                   recom_gaze_bit_mask=0, stimulus=stimuli[max(0, bisect_right(times, timestamp) - 1)][1])
        row["customMarker" if marker["type"] == "custom" else "triggerMark"] = marker.get("name", marker.get("triggerValue", ""))
        writer.writerow(row)
    output.flush()
    os.fsync(output.fileno())
    return counts


def recover_directory(directory, *, ffmpeg="ffmpeg", ffprobe="ffprobe", source_model="PupilCore"):
    """Caller must authorize the project through RecordingPaths first."""
    directory = Path(directory)
    results = []
    if not directory.exists():
        return results
    for sidecar in sorted(directory.glob("*.pupil")):
        if sidecar.is_symlink() or not sidecar.is_dir():
            continue
        name = sidecar.name[:-6]
        # Local import avoids a recorder/recovery import cycle.
        from .pupil_recorder import validate_record_name
        try:
            validate_record_name(name)
            meta_path = directory / f"{name}.meta.json"
            meta = read_json(meta_path)
            if meta.get("deviceModel") != source_model or meta.get("productIntegration") is not True:
                continue
            if meta.get("status") not in ("preparing", "recording"):
                continue
            lease = RecordingLease(sidecar)
        except (OSError, ValueError):
            continue
        try:
            # Re-read under lock: another process may have finalized while waiting.
            meta = read_json(meta_path)
            if meta.get("status") not in ("preparing", "recording"):
                continue
            manifest = read_json(sidecar / "recovery.json")
            if manifest.get("version") != 1 or manifest.get("name") != name:
                raise ValueError("Unrecognized recovery manifest")
            video, csv_path = directory / f"{name}.mp4", directory / f"{name}.csv"
            spool_path = sidecar / "gaze-spool.jsonl"
            recovery_video = sidecar / "recovered.mp4"
            recovery_csv = sidecar / "recovered.csv"
            original_video, original_csv = sidecar / "interrupted.mp4", sidecar / "interrupted.csv"
            for path in (video, csv_path, spool_path, recovery_video, recovery_csv, original_video, original_csv):
                if path.is_symlink():
                    raise ValueError("Recovery refuses symbolic links")
            # A retry after a crash during replacement always uses retained originals.
            source_video = original_video if original_video.exists() else video
            subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-y", "-i", str(source_video),
                            "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart", str(recovery_video)],
                           capture_output=True, timeout=60, check=True)
            probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-count_frames",
                                    "-show_entries", "stream=duration,nb_read_frames,width,height", "-of", "json",
                                    str(recovery_video)], capture_output=True, text=True, timeout=30, check=True)
            streams = json.loads(probe.stdout)["streams"]
            if len(streams) != 1:
                raise ValueError("Recovery requires exactly one video stream")
            stream = streams[0]
            duration, frames = float(stream["duration"]), int(stream["nb_read_frames"])
            if not math.isfinite(duration) or duration <= 0 or frames <= 0:
                raise ValueError("No recoverable video frames")
            if (int(stream["width"]), int(stream["height"])) != (manifest["encodedWidth"], manifest["encodedHeight"]):
                raise ValueError("Recovered dimensions disagree with recording manifest")
            context = read_json(sidecar / "context.json")
            with spool_path.open(encoding="utf-8") as spool, recovery_csv.open("w+", newline="", encoding="utf-8") as output:
                counts = write_gaze_csv(spool, output, duration, context["stimuli"], context["markers"], source_model=source_model)
                event_metadata = append_events(sidecar / "events-spool.jsonl", output, manifest["sourceTimeOriginS"], duration)
                event_metadata.update(append_communications(sidecar / 'communication-events.jsonl', output,
                    duration, name, manifest.get('connectionGeneration'), manifest['sourceTimeOriginS'], source_model))
                order_csv(output, sidecar)
                output.flush()
                os.fsync(output.fileno())
            if not original_video.exists():
                os.replace(video, original_video)
            if csv_path.exists() and not original_csv.exists():
                os.replace(csv_path, original_csv)
            os.replace(recovery_video, video)
            os.replace(recovery_csv, csv_path)
            meta.update(status="partial", recoveredAfterInterruption=True, videoVerified=True,
                        error="Interrupted recording recovered; trailing video/samples may be missing",
                        durationSeconds=duration, outputFrames=frames, **counts, **event_metadata,
                        markers=[m for m in context["markers"] if 0 <= m["timestamp"] < duration * 1000],
                        samplingRateHz=counts["gazeRows"] / duration,
                        validityPercent=100 * counts["validGazeRows"] / counts["gazeRows"] if counts["gazeRows"] else 0)
            journal = sidecar / "normalized-samples.jsonl"
            if source_model == "PupilCore" and journal.exists() and not journal.is_symlink():
                meta.update(journal_metrics(journal, manifest["sourceTimeOriginS"], duration))
            if event_metadata.get('communicationCaptureErrors'):
                meta['error'] += '; communication capture incomplete: ' + '; '.join(event_metadata['communicationCaptureErrors'])
            atomic_json(meta_path, meta)
            atomic_json(sidecar / 'diagnostics.json', meta)
            results.append({"recording_id": name, "status": "partial"})
        except Exception as exc:
            # Never silently treat a header-only CSV or unreadable MP4 as complete.
            meta.update(status="failed", videoVerified=False, recoveryError=str(exc))
            try:
                atomic_json(meta_path, meta)
            except OSError:
                pass
            results.append({"recording_id": name, "status": "failed", "error": str(exc)})
        finally:
            lease.close()
    return results
