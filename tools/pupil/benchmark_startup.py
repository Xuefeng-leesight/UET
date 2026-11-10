"""Measure a packaged backend's complete native-library readiness, not port binding.

Run once immediately after a clean build for first-launch evidence. Repeated runs
measure warm launches and must not be labeled cold-start results.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import subprocess
import socket
import tempfile
import time
import queue
import re
import threading

from services.eye_tracking.adapters.pupil_core.feature_worker import _read_packet, _write_packet


async def service_start(executable, source=False):
    from websockets.asyncio.client import connect
    sockets = [socket.socket() for _ in range(4)]
    try:
        for sock in sockets:
            sock.bind(('127.0.0.1', 0))
        ports = [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()
    with tempfile.TemporaryFile() as diagnostic:
        started = time.perf_counter()
        entry = [str(executable.absolute())] + (['-m', 'services.eye_tracking.entrypoints.pupil_server'] if source else [])
        process = subprocess.Popen([*entry, '--backend', 'native', '--control-stdin',
            '--image-port', str(ports[0]), '--eye-port', str(ports[1]),
            '--command-port', str(ports[2]), '--capture-port', str(ports[3])],
            stdin=subprocess.PIPE, stdout=diagnostic, stderr=diagnostic,
            env={**os.environ, 'MRT_PUPIL_BACKEND': 'native'})
        connected = None
        status = {}
        failure = None
        try:
            async with asyncio.timeout(190):
                while process.poll() is None:
                    try:
                        ws = await connect(f'ws://127.0.0.1:{ports[2]}', proxy=None)
                        break
                    except OSError:
                        await asyncio.sleep(.01)
                else:
                    raise RuntimeError(f'Backend exited with {process.returncode}')
                connected = time.perf_counter() - started
                async with ws:
                    while True:
                        await ws.send(json.dumps({'type': 'req_cmd', 'id': 'get_device_status'}))
                        status = json.loads(await ws.recv())
                        if status.get('algorithm_error'):
                            raise RuntimeError(status['algorithm_error'])
                        if status.get('algorithm_ready'):
                            break
                        await asyncio.sleep(.01)
                elapsed = time.perf_counter() - started
                if status.get('acquisition_ready') or status.get('backend') != 'native':
                    raise RuntimeError('Benchmark must prepare native algorithms without acquisition')
        except Exception as exc:
            failure = f'{type(exc).__name__}: {exc}'
            elapsed = time.perf_counter() - started
        finally:
            try:
                process.communicate(b'shutdown\n', timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                failure = failure or 'Backend did not exit after shutdown'
        diagnostic.seek(0)
        stderr = diagnostic.read().decode(errors='replace')
        entry = re.search(r'^pupil.bootstrap role=service entered_perf_s=(\d+\.\d+)$', stderr, re.MULTILINE)
        imports = re.search(r'pupil.bootstrap runtime_import_s=(\d+\.\d+)', stderr)
        return {'ready': failure is None and process.returncode == 0,
                'elapsed_s': elapsed, 'command_ready_s': connected,
                'process_to_python_entry_s': float(entry[1]) - started if entry else None,
                'runtime_import_s': float(imports[1]) if imports else None,
                'command_to_algorithm_ready_s': elapsed - connected if connected is not None else None,
                'stderr': stderr, 'result': failure}


def worker_start(executable, source=False):
    # Keep stdin OPEN until prepared. communicate(input=...) sends EOF early,
    # hiding Windows import-vs-stdin deadlocks present in the real application.
    entry = [str(executable.absolute())] + (['-m', 'services.eye_tracking.entrypoints.pupil_server'] if source else [])
    replies = queue.Queue(maxsize=1)
    with tempfile.TemporaryFile() as diagnostic:
        started = time.perf_counter()
        process = subprocess.Popen([*entry, '--native-worker', 'prepare'], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=diagnostic, bufsize=0)
        def receive():
            try:
                replies.put(_read_packet(process.stdout))
            except Exception as exc:
                replies.put({'kind': 'error', 'message': str(exc)})
        receiver = threading.Thread(target=receive, daemon=True)
        receiver.start()
        packet = {}
        failure = None
        try:
            _write_packet(process.stdin, {})
            packet = replies.get(timeout=190)
            if packet.get('kind') != 'prepared':
                failure = packet.get('message') or 'Worker did not prepare'
        except Exception as exc:
            failure = f'{type(exc).__name__}: {exc}'
        finally:
            elapsed = time.perf_counter() - started
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                failure = failure or 'Worker did not exit on parent EOF'
            receiver.join(2)
            process.stdout.close()
        diagnostic.seek(0)
        return {'ready': failure is None and process.returncode == 0,
                'elapsed_s': elapsed, 'import_seconds': packet.get('import_seconds', {}),
                'stderr': diagnostic.read().decode(errors='replace'), 'result': failure}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('executable', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--budget', type=float, default=2)
    parser.add_argument('--label', choices=('first-after-build', 'repeat'), required=True)
    parser.add_argument('--mode', choices=('service', 'worker'), default='service')
    parser.add_argument('--source', action='store_true', help='Executable is a Python interpreter; run backend source from repository root')
    args = parser.parse_args()
    if args.mode == 'service':
        report = asyncio.run(service_start(args.executable, args.source))
    else:
        report = worker_start(args.executable, args.source)
    report.update(label=args.label, mode=args.mode, source=args.source, executable=str(args.executable.absolute()), budget_s=args.budget,
                  within_budget=report['ready'] and report['elapsed_s'] <= args.budget)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['within_budget'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
