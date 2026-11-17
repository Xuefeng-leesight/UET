"""Write Pupil/Huahong recordings in the 7invensun (Pro/A8/aSee) sample CSV layout.

The recorder writes its own sample/event CSV (``internal.csv``) in its working
folder. ``<name>.csv`` is built from it here with the 7invensun header: one row
per gaze sample, the same fill rules for fields a device does not report, and
per-row event columns produced by the 7invensun event post-process itself.
That file is the recording's only CSV; playback, analysis and export read it.
"""

import csv
import math
import os
from pathlib import Path
import shutil

from ..analysis.eye_event_postprocess import postprocess_eye_event_csv
from ..analysis.seven_invensun_csv import seven_invensun_csv_header

INTERNAL_CSV_NAME = "internal.csv"
# Pupil communication capture (UDP/serial). 7invensun recordings have no such
# data; the columns are added only when a recording actually captured some.
_COMMUNICATION_COLUMNS = ("udp_send", "udp_receive", "trigger_send", "trigger_receive")

# 7invensun bit layouts as recorded by the Pro/A8 SDK for a valid sample.
_EYE_GAZE_VALID_MASK = 59
_PUPIL_VALID_MASK = 13
# 7invensun blink code while the eye is closed.
_BLINK_ACTIVE = 6
# fixation_state codes the post-process reads: 3/4 fixation (4 = last row), 1 saccade.
_STATE_NONE, _STATE_SACCADE, _STATE_FIXATION, _STATE_FIXATION_END = 0, 1, 3, 4
_MARKER_COLUMNS = ("triggerMark", "customMarker")


def internal_csv_path(sidecar):
    return Path(sidecar) / INTERNAL_CSV_NAME


def _number(value):
    try:
        text = str(value if value is not None else "").strip()
        if not text:
            return None
        number = float(text)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


def _text(value, digits=6):
    """Same decimal formatting as the 7invensun recorder."""
    if isinstance(value, int):
        return str(value)
    text = f"{float(value):.{digits}f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _bit0(value):
    number = _number(value)
    return number is not None and int(number) & 1 == 1


def _is_sample(row):
    return not row.get("source_event_type") and (row.get("gaze_valid", "") != "" or row.get("pupil_valid", "") != "")


def _event_interval(row):
    """Event start/end on the video clock (ms).

    The recorder places each event row at the event's start (its video_time_ms
    is computed from source_event_start_timestamp_s); source_timestamp_s is only
    when the SDK reported it, which for Huahong is up to ~1 s later.
    """
    start_ms = _number(row.get("video_time_ms"))
    if start_ms is None:
        return None
    duration = None
    for key in ("source_event_duration_ms", "fixation_duration_ms", "saccade_duration_ms", "blink_duration_ms"):
        duration = _number(row.get(key))
        if duration is not None:
            break
    if duration is None or duration <= 0:
        return None
    return start_ms, start_ms + duration


def _collect_events(rows):
    fixations, saccades, blinks = [], [], {"left": [], "right": []}
    for row in rows:
        kind = row.get("source_event_type")
        if kind not in ("fixation", "saccade", "blink"):
            continue
        if kind == "blink" and row.get("blink_phase") == "offset":
            continue
        interval = _event_interval(row)
        if interval is None:
            continue
        if kind == "fixation":
            x, y = _number(row.get("fixation_center_x")), _number(row.get("fixation_center_y"))
            fixations.append((*interval, x, y))
        elif kind == "saccade":
            saccades.append(interval)
        else:
            for eye in ("left", "right"):
                if _number(row.get(f"{eye}_blink")):
                    blinks[eye].append(interval)
    fixations.sort()
    saccades.sort()
    return fixations, saccades, blinks


def _inside(intervals, time_ms):
    return any(start <= time_ms <= end for start, end in intervals)


def _eye_columns(out, row, eye):
    gaze_x, gaze_y = _number(row.get(f"{eye}_gaze_x")), _number(row.get(f"{eye}_gaze_y"))
    gaze_valid = _bit0(row.get(f"{eye}_gaze_bit_mask")) and gaze_x is not None and gaze_y is not None
    out[f"{eye}_gaze_bit_mask"] = _EYE_GAZE_VALID_MASK if gaze_valid else 0
    out[f"{eye}_gaze_point_x"] = gaze_x if gaze_valid else 0
    out[f"{eye}_gaze_point_y"] = gaze_y if gaze_valid else 0
    out[f"{eye}_gaze_point_z"] = 0
    for axis in "xyz":
        out[f"{eye}_raw_point_{axis}"] = -1
        out[f"{eye}_smooth_point_{axis}"] = 0
        for name in ("origin", "direction"):
            value = _number(row.get(f"{eye}_{name}_{axis}")) if gaze_valid else None
            out[f"{eye}_{name}_{axis}"] = value if value is not None else 0
    out[f"{eye}_re"] = 1 if gaze_valid else 0

    center_x, center_y = _number(row.get(f"{eye}_pupil_center_x")), _number(row.get(f"{eye}_pupil_center_y"))
    diameter_mm = _number(row.get(f"{eye}_pupil_diameter_mm")) if row.get(f"{eye}_pupil_diameter_mm_valid") != "0" else None
    # A8 marks a pupil valid (mask 13) only together with its mm diameter; it never
    # writes an image-ratio diameter without mm. Readers fall back to the ratio
    # column when mm is 0 and would show it as millimetres, so follow A8 here.
    pupil_valid = (row.get(f"{eye}_pupil_valid") == "1" or row.get(f"{eye}_pupil_pixel_valid") == "1") \
        and center_x is not None and center_y is not None and diameter_mm is not None and diameter_mm > 0
    diameter = _number(row.get(f"{eye}_pupil_diameter")) if pupil_valid else None
    minor = _number(row.get(f"{eye}_pupil_minor_axis")) if pupil_valid else None
    out[f"{eye}_pupil_bit_mask"] = _PUPIL_VALID_MASK if pupil_valid else 0
    out[f"{eye}_pupil_center_x"] = center_x if pupil_valid else 0
    out[f"{eye}_pupil_center_y"] = center_y if pupil_valid else 0
    out[f"{eye}_pupil_distance"] = 0
    out[f"{eye}_pupil_diameter"] = diameter if diameter is not None and diameter > 0 else 0
    out[f"{eye}_pupil_diameter_mm"] = diameter_mm if pupil_valid else 0
    out[f"{eye}_pupil_minor_axis"] = minor if minor is not None and minor > 0 else 0
    out[f"{eye}_pupil_minor_axis_mm"] = 0

    openness = _number(row.get(f"{eye}_openness"))
    out[f"{eye}_eye_data_ex_bit_mask"] = 1
    out[f"{eye}_openness"] = openness if openness is not None and 0 <= openness <= 100 else 0
    out[f"{eye}_eyelid_up"] = 0
    out[f"{eye}_eyelid_down"] = 0
    out[f"{eye}_ex_data_bit_mask"] = 0


def _sample_row(row, time_ms, started_wall_ms):
    out = {}
    out["timestamp"] = int(round((started_wall_ms + time_ms) * 1000)) if started_wall_ms is not None else int(round(time_ms * 1000))
    out["video_time_ms"] = int(round(time_ms))
    out["recommend"] = 1
    x, y = _number(row.get("recom_gaze_x")), _number(row.get("recom_gaze_y"))
    valid = row.get("gaze_valid") != "0" and _bit0(row.get("recom_gaze_bit_mask")) and x is not None and y is not None
    out["recom_gaze_x"] = x if valid else -1
    out["recom_gaze_y"] = y if valid else -1
    out["recom_gaze_bit_mask"] = 1 if valid else 0
    out["recom_gaze_point_x"] = x if valid else 0
    out["recom_gaze_point_y"] = y if valid else 0
    out["recom_gaze_point_z"] = 0
    for axis in "xyz":
        out[f"recom_raw_point_{axis}"] = 0
        out[f"recom_smooth_point_{axis}"] = 0
        for name in ("origin", "direction"):
            value = _number(row.get(f"recom_{name}_{axis}")) if valid else None
            out[f"recom_{name}_{axis}"] = value if value is not None else 0
    out["recom_re"] = 0
    for eye in ("left", "right"):
        _eye_columns(out, row, eye)
    # Outside a fixation the 7invensun SDK reports these defaults; the post-process
    # keeps them in its sdk_fixation_* backup columns before clearing the originals.
    out.update(fixation_timestamp=0, fixation_duration=0, fixation_timestamp_us=0, fixation_duration_us=0,
               fixation_timestamp_ms=0, fixation_duration_ms=0, fixation_count=0,
               fixation_center_x=-1, fixation_center_y=-1)
    out["stimulus"] = row.get("stimulus", "")
    return out


def _fixation_fields(out, fixation, number, started_wall_ms):
    start_ms, end_ms, x, y = fixation
    wall_start = (started_wall_ms + start_ms) if started_wall_ms is not None else start_ms
    duration = end_ms - start_ms
    out["fixation_timestamp"] = wall_start
    out["fixation_timestamp_ms"] = wall_start
    out["fixation_timestamp_us"] = wall_start * 1000
    out["fixation_duration"] = duration
    out["fixation_duration_ms"] = duration
    out["fixation_duration_us"] = duration * 1000
    out["fixation_count"] = number
    if x is not None and y is not None:
        out["fixation_center_x"] = x
        out["fixation_center_y"] = y


def write_seven_invensun_csv(csv_path, source_csv, *, width, height, started_wall_ms=None):
    """Build ``csv_path`` in the 7invensun layout from the recorder CSV ``source_csv``.

    The source usually sits in the working folder, possibly on another drive, so
    nothing is renamed across them: the result is written next to ``csv_path``.
    If the conversion fails, ``csv_path`` receives a copy of the recorder CSV so
    the recording still opens like one saved before this layout existed.
    """
    csv_path, source_csv = Path(csv_path), Path(source_csv)
    try:
        return _write_layout(csv_path, source_csv, width, height, started_wall_ms)
    except Exception:
        if not csv_path.exists():
            shutil.copyfile(source_csv, csv_path)
        raise


def _write_layout(csv_path, internal, width, height, started_wall_ms):
    with internal.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    fixations, saccades, blinks = _collect_events(rows)
    communications = any(row.get("source_event_type") == "communication" and any(row.get(key) for key in _COMMUNICATION_COLUMNS)
                         for row in rows)
    header = list(seven_invensun_csv_header()) + (list(_COMMUNICATION_COLUMNS) if communications else [])
    temp = csv_path.with_name(f".{csv_path.name}.{os.getpid()}.layout.tmp")
    pending_markers = {key: [] for key in (*_MARKER_COLUMNS, *_COMMUNICATION_COLUMNS)}
    written = 0
    try:
        with temp.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=header, extrasaction="ignore")
            writer.writeheader()
            fixation_cursor = 0
            previous_fixation = None
            sample_rows = []
            for row in rows:
                if not _is_sample(row):
                    kind = row.get("source_event_type")
                    # Marker and communication rows have no gaze; attach them to the
                    # next sample like 7invensun does with markers.
                    keys = _MARKER_COLUMNS if not kind else _COMMUNICATION_COLUMNS if kind == "communication" else ()
                    for key in keys:
                        if row.get(key):
                            pending_markers[key].append(row[key])
                    continue
                time_ms = _number(row.get("video_time_ms"))
                if time_ms is None:
                    continue
                out = _sample_row(row, time_ms, started_wall_ms)
                for key in pending_markers:
                    values = [value for value in (row.get(key, ""),) if value] if key in _MARKER_COLUMNS else []
                    values += pending_markers[key]
                    # Communication payloads are JSON envelopes (they contain commas).
                    out[key] = (",".join(values) if key in _MARKER_COLUMNS else " ".join(values))
                    pending_markers[key] = []
                for eye in ("left", "right"):
                    out[f"{eye}_blink"] = _BLINK_ACTIVE if _inside(blinks[eye], time_ms) else 0
                while fixation_cursor < len(fixations) and fixations[fixation_cursor][1] < time_ms:
                    fixation_cursor += 1
                fixation = None
                if fixation_cursor < len(fixations) and fixations[fixation_cursor][0] <= time_ms:
                    fixation = fixation_cursor
                if fixation is not None:
                    # Back-to-back fixations need a non-fixation row between them,
                    # or the post-process merges them into one event.
                    if previous_fixation is not None and previous_fixation != fixation and sample_rows \
                            and sample_rows[-1]["fixation_state"] in (_STATE_FIXATION, _STATE_FIXATION_END):
                        out["fixation_state"] = _STATE_NONE
                    else:
                        out["fixation_state"] = _STATE_FIXATION
                        _fixation_fields(out, fixations[fixation], fixation + 1, started_wall_ms)
                elif _inside(saccades, time_ms):
                    out["fixation_state"] = _STATE_SACCADE
                else:
                    out["fixation_state"] = _STATE_NONE
                if sample_rows and sample_rows[-1]["fixation_state"] == _STATE_FIXATION \
                        and (out["fixation_state"] != _STATE_FIXATION or fixation != previous_fixation):
                    sample_rows[-1]["fixation_state"] = _STATE_FIXATION_END
                previous_fixation = fixation if out["fixation_state"] == _STATE_FIXATION else None
                sample_rows.append(out)
            if sample_rows and sample_rows[-1]["fixation_state"] == _STATE_FIXATION:
                sample_rows[-1]["fixation_state"] = _STATE_FIXATION_END
            if sample_rows:
                # Markers after the last sample stay on the last row instead of being dropped.
                for key in pending_markers:
                    if pending_markers[key]:
                        last = sample_rows[-1]
                        joiner = "," if key in _MARKER_COLUMNS else " "
                        last[key] = joiner.join([value for value in (last.get(key, ""),) if value] + pending_markers[key])
            for out in sample_rows:
                writer.writerow({key: _text(value) if isinstance(value, (int, float)) else value for key, value in out.items()})
                written += 1
        result = postprocess_eye_event_csv(temp, width, height, is_glasses_mode=False)
        os.replace(temp, csv_path)
    finally:
        if temp.exists():
            try:
                temp.unlink()
            except OSError:
                pass
    return {"standardCsvLayout": "7invensun", "standardCsvRows": written,
            "standardCsvFixations": result.get("fixations", 0), "standardCsvSaccades": result.get("saccades", 0)}
