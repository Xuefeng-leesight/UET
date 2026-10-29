"""Development-only Pupil preview and optional MRT-owned recording session."""

import argparse
import asyncio
import json
import math
from pathlib import Path
import sys
import threading
import time

from services.eye_tracking.domain.samples import VideoFrame
from services.eye_tracking.adapters.pupil_core.network import NetworkConfig
from .preview import LatestFrames, PreviewServer
from services.eye_tracking.infrastructure.pupil_recorder import PupilRecorder, validate_record_name
from services.eye_tracking.adapters.pupil_core.service import PupilService


class AcquisitionSession:
    def __init__(self, config: NetworkConfig, frames: LatestFrames, *, seconds: float,
                 output_dir: Path | None = None, name: str = "pupil-test", fps: int = 30,
                 ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe"):
        self.config, self.frames, self.seconds = config, frames, seconds
        self.output_dir, self.name, self.fps = output_dir, name, fps
        self.ffmpeg, self.ffprobe = ffmpeg, ffprobe
        self.stop = threading.Event()
        self.done = threading.Event()
        self.result = {}
        self.thread = threading.Thread(target=self._run, name="pupil-acquisition", daemon=True)

    def _run(self) -> None:
        service = PupilService(self.config)
        recorder = None
        error = ""
        try:
            service.connect()
            self.result["capture_version"] = service.network.version
            self.frames.source_info = {"captureVersion": service.network.version,
                                       "simulatedSource": service.network.version.startswith("mrt-pupil-simulator/")}
            deadline = time.monotonic() + self.seconds
            while not self.stop.is_set() and time.monotonic() < deadline:
                samples = service.read(20)
                for sample in samples:
                    if isinstance(sample, VideoFrame):
                        self.frames.put(sample)
                if recorder is None and self.output_dir is not None:
                    first = next((s for s in samples if isinstance(s, VideoFrame) and s.stream == "scene"), None)
                    if first is not None:
                        recorder = PupilRecorder(self.output_dir, self.name, first, fps=self.fps,
                                                 ffmpeg=self.ffmpeg, ffprobe=self.ffprobe, source_info=self.frames.source_info)
                        recorder.start()
                        samples = [sample for sample in samples if sample is not first]
                if recorder is not None:
                    recorder.submit(samples, service.last_messages)
        except Exception as exc:
            error = str(exc)
        finally:
            record_result = None
            try:
                service.close()
            except Exception as exc:
                error = error or str(exc)
            try:
                record_result = recorder.finish(error=error) if recorder is not None else None
            except Exception as exc:
                error = error or str(exc)
            if record_result and record_result.get("status") != "complete":
                error = error or record_result.get("error", "Recording failed")
            if self.output_dir is not None and not record_result and not error:
                error = "No recording was started"
            self.result.update(status="failed" if error else "stopped" if self.stop.is_set() else "complete",
                               error=error, product_integration=False, calibration_verified=False,
                               received_by_topic=dict(service.received), recording=record_result)
            self.done.set()


async def run_session(args) -> dict:
    frames = LatestFrames()
    preview = PreviewServer(frames, port=args.preview_port, origin=args.preview_origin)
    acquisition = AcquisitionSession(NetworkConfig(remote_port=args.port), frames, seconds=args.seconds,
                                     output_dir=args.output_dir, name=args.name, fps=args.fps,
                                     ffmpeg=args.ffmpeg, ffprobe=args.ffprobe)
    try:
        await preview.start()
        print(json.dumps({"preview_url": f"http://127.0.0.1:{preview.port}",
                          "websocket_url": f"ws://127.0.0.1:{preview.port}", "product_integration": False}), flush=True)
        acquisition.thread.start()
        while not acquisition.done.is_set():
            preview.check()
            await asyncio.sleep(0.05)
        return acquisition.result
    finally:
        acquisition.stop.set()
        await preview.close()
        if acquisition.thread.ident is not None:
            await asyncio.to_thread(acquisition.thread.join, 30)
            if acquisition.thread.is_alive():
                raise RuntimeError("Acquisition worker did not stop; recording is not finalized")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=50020)
    parser.add_argument("--preview-port", type=int, default=9101)
    parser.add_argument("--preview-origin", help="Exact allowed browser Origin; omitted means native clients only")
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--output-dir", type=Path, help="Explicit development output directory; omit for preview only")
    parser.add_argument("--name", default="pupil-test")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    args = parser.parse_args(argv)
    try:
        NetworkConfig(remote_port=args.port)
        validate_record_name(args.name)
        if not math.isfinite(args.seconds) or not 0 < args.seconds <= 3600:
            raise ValueError("Session duration must be within (0, 3600] seconds")
        if not 1 <= args.preview_port <= 65535 or args.preview_port in (9001, 9002, 9003, args.port):
            raise ValueError("Use a dedicated preview port, not a legacy MRT or Capture port")
        if not 1 <= args.fps <= 120:
            raise ValueError("Output FPS must be within 1..120")
    except ValueError as exc:
        parser.error(str(exc))
    try:
        result = asyncio.run(run_session(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        result = {"status": "failed", "error": str(exc), "product_integration": False}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0 if result["status"] == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())
