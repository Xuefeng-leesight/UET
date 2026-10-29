"""Owned pipe worker; bounded queues, EOF cleanup and killable computations."""
import logging
import queue
import subprocess
import sys
import threading
import time

from ..pupil_core.feature_worker import _read_packet, _write_packet


class PipeWorker:
    def __init__(self, kind, task, capacity=64):
        self.results = queue.Queue(maxsize=capacity)
        self.closed = False
        self.error = ''
        self.process = None
        self.started = time.monotonic()
        self._lock = threading.Lock()
        self._threads = []
        self._spawn(self._launch, kind, task)

    def _spawn(self, fn, *args):
        thread = threading.Thread(target=fn, args=args, daemon=True, name='pupil-native-pipe')
        self._threads.append(thread)
        thread.start()

    def _launch(self, kind, task):
        entry = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, '-m', 'services.eye_tracking.entrypoints.pupil_server']
        child = None
        try:
            child = subprocess.Popen([*entry, '--native-worker', kind], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                     creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
            with self._lock:
                if self.closed:
                    self._dispose(child)
                    return
                self.process = child
            self._spawn(self._read, child)
            self._spawn(self._stderr, child)
            _write_packet(child.stdin, task)
            # Keep stdin open as a parent-liveness handle until close().
        except Exception as exc:
            if not self.closed:
                self.error = f'Native worker startup: {exc}'
            if child is not None:
                self._dispose(child)

    def _read(self, child):
        try:
            # Keep the output pipe open until the child observes parent EOF and
            # releases its camera. Closing after the next in-flight frame races
            # its final write on Windows (OSError 22), even on a normal stop.
            while True:
                packet = _read_packet(child.stdout)
                if not self.closed:
                    try:
                        self.results.put_nowait(packet)
                    except queue.Full:
                        if self.closed:
                            # close() may win between the check and enqueue.
                            # Shutdown still owns draining the child's writes.
                            continue
                        self.error = 'Native acquisition queue overflow; recording cannot be treated as complete'
                        return
        except Exception as exc:
            if not self.closed:
                self.error = self.error or f'Native worker output failed: {exc}'
        finally:
            child.stdout.close()

    def _stderr(self, child):
        try:
            for line in iter(child.stderr.readline, b''):
                logging.info('pupil.native child: %s', line.decode('utf-8', errors='replace').rstrip())
        except (OSError, ValueError):
            if not self.closed:
                self.error = 'Native worker diagnostic pipe failed'
        finally:
            child.stderr.close()

    def poll(self, limit=64):
        values = []
        for _ in range(limit):
            try:
                values.append(self.results.get_nowait())
            except queue.Empty:
                break
        return values

    @staticmethod
    def _dispose(child):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(.2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(1)
        for stream in (child.stdin, child.stdout, child.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass

    def close(self):
        with self._lock:
            if self.closed:
                return
            self.closed = True
            child = self.process
        if child is not None:
            # EOF lets camera workers release UVC naturally. A hung detector is bounded.
            try:
                child.stdin.close()
                child.wait(.3)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
            self._dispose(child)
