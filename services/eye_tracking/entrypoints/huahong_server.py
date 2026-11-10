"""Independent Huahong Windows x64 process entry point."""

import sys

if __name__ == '__main__' and len(sys.argv) == 3 and sys.argv[1] == '--gaze-map-job':
    # Offline analysis is independent of SDK model, DLLs and camera acquisition.
    from services.eye_tracking.analysis.gaze_mapper import main as mapping_main
    raise SystemExit(mapping_main(['--job', sys.argv[2]]))

import argparse
import asyncio
import faulthandler
import logging
from pathlib import Path
import signal
import threading
import time

from services.eye_tracking.adapters.huahong.service import MODELS
from services.eye_tracking.application.huahong_runtime import HuahongRuntime
from services.eye_tracking.transport.huahong_runtime import HuahongWebSocketServer


async def run(args):
    runtime = HuahongRuntime(args.model, args.sdk_root,
                           project_roots=args.project_root, ffmpeg=args.ffmpeg, ffprobe=args.ffprobe)
    server = HuahongWebSocketServer(runtime, image_port=args.image_port, eye_port=args.eye_port,
                                 command_port=args.command_port, origins=args.origin)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    if args.control_stdin:
        def watch_parent():
            for line in sys.stdin:
                if line.strip() == 'shutdown':
                    break
            if not loop.is_closed():
                loop.call_soon_threadsafe(stop.set)
        threading.Thread(target=watch_parent, name='huahong-parent-control', daemon=True).start()
    previous = {}
    for sig in (signal.SIGINT, signal.SIGTERM):
        previous[sig] = signal.getsignal(sig)
        signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
    try:
        await server.start()
        logging.info("Huahong service listening on loopback %s; acquisition remains idle until start", server.ports)
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
    parser.add_argument("--model", choices=MODELS, required=True)
    parser.add_argument("--sdk-root", type=Path, required=True)
    parser.add_argument("--image-port", type=int, default=9001)
    parser.add_argument("--eye-port", type=int, default=9002)
    parser.add_argument("--command-port", type=int, default=9003)
    parser.add_argument("--project-root", type=Path, action="append", default=[],
                        help="Allowed existing Huahong project root; includes its experiments; repeat for multiple projects")
    parser.add_argument("--origin", action="append", default=[], help="Exact allowed browser Origin")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--control-stdin", action="store_true", help="Accept parent shutdown and exit on parent pipe EOF")
    args = parser.parse_args(argv)
    ports = (args.image_port, args.eye_port, args.command_port)
    if len(set(ports)) != 3 or any(not 1 <= port <= 65535 for port in ports):
        parser.error("All three ports must be distinct and within 1..65535")
    # Frozen executables may ignore PYTHON* launch settings. Flush diagnostics
    # before a native DLL failure and preserve all Python thread stacks on stderr.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(line_buffering=True, write_through=True)
    faulthandler.enable(all_threads=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.info('Huahong runtime python=%s version=%s frozen=%s',
                 sys.executable, sys.version.split()[0], bool(getattr(sys, 'frozen', False)))
    for role, name in (('source', 'perf_counter'), ('receive', 'monotonic')):
        clock = time.get_clock_info(name)
        logging.info('Huahong clock role=%s name=%s implementation=%s resolution_s=%s',
                     role, name, clock.implementation, clock.resolution)
    try:
        asyncio.run(run(args))
    except Exception:
        logging.exception("Huahong service failed")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
