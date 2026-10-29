"""Bounded pipe protocol for a dedicated scene tracker process.

The child enters a lightweight explicit entry point, without multiprocessing's
Windows main-module replay and named Queue/semaphore bootstrap.
"""
import importlib
import logging
import queue
import struct
import subprocess
import sys
import threading
import time

from .natural_feature import NaturalFeatureTracker

MAX_PACKET = 40 * 1024 * 1024


def _read_exact(stream, count):
    chunks = bytearray()
    while len(chunks) < count:
        chunk = stream.read(count - len(chunks))
        if not chunk:
            raise EOFError('Tracker pipe closed')
        chunks.extend(chunk)
    return bytes(chunks)


def _read_packet(stream):
    import msgpack
    size = struct.unpack('!I', _read_exact(stream, 4))[0]
    if not 0 < size <= MAX_PACKET:
        raise ValueError('Tracker packet exceeds limit')
    return msgpack.unpackb(_read_exact(stream, size), raw=False, strict_map_key=True)


def _write_packet(stream, packet):
    import msgpack
    data = msgpack.packb(packet, use_bin_type=True)
    if len(data) > MAX_PACKET:
        raise ValueError('Tracker packet exceeds limit')
    packet_bytes = struct.pack('!I', len(data)) + data
    view = memoryview(packet_bytes)
    while view:
        written = stream.write(view)
        if not written:
            raise EOFError('Tracker pipe closed')
        view = view[written:]
    stream.flush()


def worker_main(factory_spec):
    import faulthandler
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    faulthandler.enable()
    faulthandler.dump_traceback_later(5, repeat=False)
    logging.info('pupil.feature bootstrap entered; python=%s', sys.executable)
    try:
        module, name = factory_spec.split(':', 1)
        factory = getattr(importlib.import_module(module), name)
        if factory is NaturalFeatureTracker:
            import cv2
            import numpy as np
            cv2.setNumThreads(1)
            cv2.ocl.setUseOpenCL(False)
            logging.info('pupil.feature dependencies; cv2=%s numpy=%s', cv2.__version__, np.__version__)
        _write_packet(sys.stdout.buffer, {'kind': 'ready'})
    except Exception as exc:
        logging.exception('pupil.feature startup failed')
        _write_packet(sys.stdout.buffer, {'kind': 'startup_error', 'reason': str(exc)})
        return 1
    finally:
        faulthandler.cancel_dump_traceback_later()
    tracker = None
    while True:
        try:
            task = _read_packet(sys.stdin.buffer)
        except EOFError:
            return 0
        from .network import WireMessage
        message = WireMessage(task['topic'], task['payload'], tuple(task['raw_parts']), task['received'])
        sample_id, kind = task['sample_id'], task['kind']
        started = time.monotonic()
        faulthandler.dump_traceback_later(1, repeat=False)
        try:
            if kind == 'init':
                tracker = factory(message, *task['point'])
                result = {'kind': 'initialized', 'sample_id': sample_id}
            else:
                result = {'kind': 'frame', 'sample_id': sample_id, 'position': tracker.update(message),
                          'timestamp': message.payload['timestamp'], 'width': message.payload['width'],
                          'height': message.payload['height'], 'received': message.received_monotonic_s}
        except Exception as exc:
            result = {'kind': 'error', 'sample_id': sample_id, 'reason': str(exc)}
        finally:
            faulthandler.cancel_dump_traceback_later()
        _write_packet(sys.stdout.buffer, result)
        if kind == 'init' or time.monotonic() - started > .1:
            logging.info('pupil.feature operation; kind=%s elapsed_ms=%s', kind, round((time.monotonic() - started) * 1000))


class _Process:
    """Small process lifecycle interface shared by the owner and launch cleanup."""
    def __init__(self, child):
        self.child = child
        self.pid = child.pid

    @property
    def exitcode(self):
        return self.child.poll()

    def is_alive(self):
        return self.child.poll() is None

    def terminate(self):
        self.child.terminate()

    def kill(self):
        self.child.kill()

    def join(self, timeout):
        try:
            self.child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            pass


class FeatureWorker:
    def __init__(self, factory=NaturalFeatureTracker):
        self.tasks, self.results = queue.Queue(maxsize=1), queue.Queue(maxsize=4)
        self.process = None
        self.ready, self.busy, self.error = False, False, ''
        self.closed = False
        self.started, self.busy_since = time.monotonic(), 0
        self._lifecycle = threading.Lock()
        self._starter = threading.Thread(target=self._launch, args=(factory,), name='pupil-feature-launch', daemon=True)
        self._starter.start()

    def _launch(self, factory):
        process = None
        try:
            if '<' in factory.__qualname__ or '.' in factory.__qualname__:
                raise ValueError('Tracker factory must be a module-level callable')
            spec = f'{factory.__module__}:{factory.__qualname__}'
            entry = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, '-m', 'services.eye_tracking.entrypoints.pupil_server']
            logging.info('pupil.feature launch requested; execution=pipe-v3')
            child = subprocess.Popen([*entry, '--feature-worker', spec], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, bufsize=0,
                                     creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
            process = _Process(child)
            with self._lifecycle:
                if self.closed:
                    return
                self.process = process
                process = None
            for target in (self._send, self._receive, self._stderr):
                threading.Thread(target=target, args=(child,), name='pupil-feature-pipe', daemon=True).start()
            logging.info('pupil.feature launch returned; pid=%s elapsed_ms=%s', child.pid, round((time.monotonic() - self.started) * 1000))
        except Exception as exc:
            with self._lifecycle:
                if not self.closed:
                    self.error = f'追踪进程启动失败：{exc}'
        finally:
            if process is not None:
                self._dispose(process, close_pipes=True)

    def _send(self, child):
        try:
            while not self.closed:
                try:
                    task = self.tasks.get(timeout=.1)
                except queue.Empty:
                    continue
                _write_packet(child.stdin, task)
        except (OSError, EOFError, ValueError) as exc:
            if not self.closed:
                self.error = f'追踪进程输入失败：{exc}'
        finally:
            child.stdin.close()

    def _receive(self, child):
        try:
            while not self.closed:
                reply = _read_packet(child.stdout)
                while not self.closed:
                    try:
                        self.results.put(reply, timeout=.1)
                        break
                    except queue.Full:
                        continue
        except (OSError, EOFError, ValueError) as exc:
            if not self.closed:
                self.error = f'追踪进程输出失败：{exc}'
        finally:
            child.stdout.close()

    def _stderr(self, child):
        try:
            for line in iter(child.stderr.readline, b''):
                logging.info('pupil.feature child: %s', line.decode('utf-8', errors='replace').rstrip())
        finally:
            child.stderr.close()

    @staticmethod
    def _dispose(process, close_pipes=False):
        if process.is_alive():
            process.terminate()
            process.join(.1)
            if process.is_alive():
                process.kill()
                process.join(.1)
        else:
            process.join(0)
        # A late canceled launch has no pipe threads to close its handles.
        if close_pipes:
            for stream in (process.child.stdin, process.child.stdout, process.child.stderr):
                if not stream.closed:
                    stream.close()

    def submit(self, sample_id, kind, message, point=None):
        if self.closed or not self.ready or self.busy or self.error:
            return False
        task = {'sample_id': sample_id, 'kind': kind, 'topic': message.topic, 'payload': message.payload,
                'raw_parts': message.raw_parts, 'received': message.received_monotonic_s, 'point': point}
        try:
            self.tasks.put_nowait(task)
            self.busy, self.busy_since = True, time.monotonic()
            return True
        except queue.Full:
            return False

    def poll(self):
        if self.closed:
            return []
        replies = []
        while True:
            try:
                reply = self.results.get_nowait()
            except queue.Empty:
                break
            if reply['kind'] == 'ready':
                self.ready = True
            elif reply['kind'] == 'startup_error':
                self.error = reply['reason']
            else:
                self.busy = False
                replies.append(reply)
        if self.process is not None and not self.process.is_alive() and not self.error:
            self.error = f'追踪进程已退出（exit={self.process.exitcode}）'
        if not self.error and not self.ready and time.monotonic() - self.started > 60:
            self.error = '追踪进程初始化超过 60 秒，请重新启动校准并检查 Pupil 后端日志'
        if not self.error and self.busy and time.monotonic() - self.busy_since > 2:
            self.error = '目标追踪计算超过 2 秒，请重新启动校准'
        if self.error:
            logging.warning('pupil.feature stopped: %s', self.error)
            self.close()
        return replies

    def close(self):
        with self._lifecycle:
            if self.closed:
                return
            self.closed = True
            process = self.process
        if process is not None:
            self._dispose(process)
