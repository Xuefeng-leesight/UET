"""Independent PupilCore process entry point for Windows and macOS."""

# Dispatch before importing the runtime; child must never replay server startup.
import sys
import time
_entry_started = time.perf_counter()
if __name__ == '__main__':
    _entry_role = sys.argv[2] if len(sys.argv) == 3 and sys.argv[1] in ('--native-worker', '--feature-worker') else 'service'
    if len(sys.argv) == 3 and sys.argv[1] == '--gaze-map-job':
        _entry_role = 'gaze-mapping'
    print(f'pupil.bootstrap role={_entry_role} entered_perf_s={_entry_started:.9f}', file=sys.stderr, flush=True)
if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--gaze-map-job':
    # Offline analysis needs only OpenCV/NumPy, never camera preparation,
    # WebSocket servers, a calibration session or the acquisition parent pipe.
    from services.eye_tracking.analysis.gaze_mapper import main as mapping_main
    raise SystemExit(mapping_main(['--job', sys.argv[2]]))
if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--native-worker':
    from services.eye_tracking.adapters.pupil_native.worker import worker_main
    raise SystemExit(worker_main(sys.argv[2]))
if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--feature-worker':
    from services.eye_tracking.adapters.pupil_core.feature_worker import worker_main
    raise SystemExit(worker_main(sys.argv[2]))

import faulthandler
import argparse
import asyncio
import logging
from pathlib import Path
import signal
import sys
import threading

from services.eye_tracking.adapters.pupil_core.network import NetworkConfig
from services.eye_tracking.application.pupil_runtime import PupilRuntime
from services.eye_tracking.transport.pupil_runtime import PupilWebSocketServer
from services.eye_tracking.infrastructure.pupil_parent_pipe import parent_pipe_reader, wait_for_parent


async def run(args):
    source = None
    if args.backend == 'native':
        from services.eye_tracking.adapters.pupil_native.config import NativeConfig
        from services.eye_tracking.adapters.pupil_native.source import NativeSource
        source = NativeSource(NativeConfig(camera_uids=tuple(args.camera_uid), intrinsics_path=args.intrinsics,
                                           eye_fps=args.eye_fps, world_fps=args.world_fps))
    runtime = PupilRuntime(NetworkConfig(remote_port=args.capture_port, request_timeout_ms=500),
                           project_roots=args.project_root, ffmpeg=args.ffmpeg, ffprobe=args.ffprobe, source=source,
                           prepare_native=args.backend == 'native')
    server = PupilWebSocketServer(runtime, image_port=args.image_port, eye_port=args.eye_port,
                                 command_port=args.command_port, origins=args.origin)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    if args.control_stdin:
        read_parent = parent_pipe_reader(sys.stdin.buffer)
        def watch_parent():
            try:
                wait_for_parent(read_parent, shutdown_command=True)
            except Exception:
                logging.exception('Pupil parent control pipe failed')
            finally:
                if not loop.is_closed():
                    loop.call_soon_threadsafe(stop.set)
        threading.Thread(target=watch_parent, name='pupil-parent-control', daemon=True).start()
    previous = {}
    for sig in (signal.SIGINT, signal.SIGTERM):
        previous[sig] = signal.getsignal(sig)
        signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
    try:
        await server.start()
        logging.info("PupilCore service listening on loopback %s; acquisition remains idle until start", server.ports)
        stop_task = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait((stop_task, server.publisher), return_when=asyncio.FIRST_COMPLETED)
            if server.publisher in done:
                server.publisher.result()
        finally:
            stop_task.cancel()
            await asyncio.gather(stop_task, return_exceptions=True)
    finally:
        await server.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=('native', 'capture'), default='native')
    parser.add_argument('--camera-uid', action='append', default=[], help='Right, left, scene UID; specify all three')
    parser.add_argument('--intrinsics', default='', help='Optional JSON camera calibration by name/resolution')
    parser.add_argument('--eye-fps', type=int, default=120)
    parser.add_argument('--world-fps', type=int, default=30)
    parser.add_argument("--capture-port", type=int, default=50020)
    parser.add_argument("--image-port", type=int, default=9001)
    parser.add_argument("--eye-port", type=int, default=9002)
    parser.add_argument("--command-port", type=int, default=9003)
    parser.add_argument("--project-root", type=Path, action="append", default=[],
                        help="Allowed existing PupilCore project root; includes its experiments; repeat for multiple projects")
    parser.add_argument("--origin", action="append", default=[], help="Exact allowed browser Origin")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--control-stdin", action="store_true", help="Accept parent shutdown and exit on parent pipe EOF")
    args = parser.parse_args(argv)
    ports = (args.image_port, args.eye_port, args.command_port, args.capture_port)
    if len(set(ports)) != 4 or any(not 1 <= port <= 65535 for port in ports):
        parser.error("All four ports must be distinct and within 1..65535")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    faulthandler.enable()
    logging.info("pupil.backend revision=pupil-native-v7-score backend=%s python=%s entry=%s calibration=%s frozen=%s",
                 args.backend, sys.executable, Path(__file__).resolve(),
                 sys.modules["services.eye_tracking.adapters.pupil_core.calibration"].__file__,
                 getattr(sys, "frozen", False))
    logging.info('pupil.bootstrap runtime_import_s=%.6f', time.perf_counter() - _entry_started)
    try:
        asyncio.run(run(args))
    except Exception:
        logging.exception("PupilCore service failed")
        return 1
    return 0


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    raise SystemExit(main())
