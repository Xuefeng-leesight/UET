"""Parent liveness must not prevent native DLL imports on Windows."""
import io
import queue
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from services.eye_tracking.infrastructure.pupil_parent_pipe import parent_pipe_reader, wait_for_parent
from services.eye_tracking.adapters.pupil_native.process import PipeWorker
from services.eye_tracking.adapters.pupil_core.feature_worker import _read_packet, _write_packet


class ParentPipeTests(unittest.TestCase):
    def test_windows_reader_preserves_handle_and_bypasses_crt_reads(self):
        import ctypes
        from unittest.mock import Mock
        stream = Mock()
        stream.fileno.return_value = 0
        stream.read.side_effect = AssertionError('Windows control must not hold CRT read lock')
        available_counts = [0, 0, 1, None]
        def peek(handle, buffer, size, count, available, remaining):
            self.assertEqual(handle.value, 0x100000001)
            value = available_counts.pop(0)
            if value is None:
                return 0
            available._obj.value = value
            return 1
        def read_file(handle, buffer, size, count, overlapped):
            self.assertEqual(handle.value, 0x100000001)
            self.assertIsNone(overlapped)
            self.assertEqual(size, 1)
            buffer[0] = b'x'
            count._obj.value = 1
            return 1
        kernel = SimpleNamespace(ReadFile=Mock(side_effect=read_file), PeekNamedPipe=Mock(side_effect=peek))
        with patch('sys.platform', 'win32'), \
             patch.dict(sys.modules, {'msvcrt': SimpleNamespace(get_osfhandle=lambda fd: 0x100000001)}), \
             patch.object(ctypes, 'WinDLL', return_value=kernel, create=True), \
             patch.object(ctypes, 'get_last_error', return_value=109, create=True), \
             patch('services.eye_tracking.infrastructure.pupil_parent_pipe.time.sleep') as sleep:
            read = parent_pipe_reader(stream)
            self.assertEqual(read(10), b'x')
            self.assertEqual(read(1), b'')
            self.assertEqual(sleep.call_count, 2)
            kernel.ReadFile.assert_called_once()

    def test_native_libraries_load_before_monitor_for_all_worker_kinds(self):
        from services.eye_tracking.adapters.pupil_native import worker
        from unittest.mock import Mock
        for kind in ('prepare', 'camera', 'fit'):
            with self.subTest(kind=kind):
                source, output = io.BytesIO(), io.BytesIO()
                _write_packet(source, {'intrinsics': {}, 'refs': [], 'pupils': [], 'request_id': 'test'})
                source.seek(0)
                started = []
                def load():
                    self.assertEqual(started, [], 'DLL load overlapped parent reader')
                    return {'numpy': .01}
                with patch.object(worker.sys, 'stdin', SimpleNamespace(buffer=source)), \
                     patch.object(worker.sys, 'stdout', SimpleNamespace(buffer=output)), \
                     patch.object(worker.threading, 'Event', return_value=Mock()), \
                     patch.object(worker.threading.Thread, 'start', side_effect=lambda: started.append(True)), \
                     patch.object(worker, 'parent_pipe_reader', return_value=source.read), \
                     patch.object(worker, 'camera_loop') as camera, \
                     patch('services.eye_tracking.adapters.pupil_native.gazer.NativeGazer') as gazer, \
                     patch('services.eye_tracking.adapters.pupil_native.preparation.load_dependencies', side_effect=load):
                    gazer.return_value.fit.return_value = {}
                    self.assertEqual(worker.worker_main(kind), 0)
                    self.assertEqual(started, [True])
                if kind == 'camera':
                    camera.assert_called_once()
                else:
                    output.seek(0)
                    self.assertEqual(_read_packet(output)['kind'], 'prepared' if kind == 'prepare' else 'fit')

    def test_shutdown_line_and_eof(self):
        stream = io.BytesIO(b'ignored\r\n shutdown\r\nremaining')
        wait_for_parent(stream.read, shutdown_command=True)
        self.assertEqual(stream.read(), b'remaining')
        wait_for_parent(io.BytesIO(b'ignored\n').read, shutdown_command=True)
        with self.assertRaisesRegex(ValueError, 'exceeds limit'):
            wait_for_parent(io.BytesIO(b'x' * 1025).read, shutdown_command=True)

    def test_pipe_decode_dependency_failure_reaches_owner(self):
        worker = PipeWorker.__new__(PipeWorker)
        worker.closed, worker.error = False, ''
        worker.results = queue.Queue()
        class Child:
            stdout = io.BytesIO()
        with patch('services.eye_tracking.adapters.pupil_native.process._read_packet',
                   side_effect=ModuleNotFoundError("No module named 'msgpack'")):
            worker._read(Child())
        self.assertIn('msgpack', worker.error)
        self.assertTrue(Child.stdout.closed)

    def test_stop_drains_inflight_frames_until_child_exits(self):
        worker = PipeWorker.__new__(PipeWorker)
        worker.closed, worker.error = False, ''
        worker.results = queue.Queue(maxsize=1)
        child = SimpleNamespace(stdout=io.BytesIO())
        calls = []

        def read(stream):
            self.assertFalse(stream.closed, 'Parent closed stdout before camera released it')
            calls.append(True)
            if len(calls) == 1:
                worker.closed = True  # close() while the first frame is in flight
            if len(calls) <= 3:
                return {'kind': 'data'}
            raise EOFError('Child observed stdin EOF and released the camera')

        with patch('services.eye_tracking.adapters.pupil_native.process._read_packet', side_effect=read):
            worker._read(child)
        self.assertEqual(len(calls), 4)
        self.assertTrue(worker.results.empty(), 'Closed sessions must not enqueue late frames')
        self.assertEqual(worker.error, '')
        self.assertTrue(child.stdout.closed)

    def test_stop_between_closed_check_and_full_enqueue_keeps_draining(self):
        worker = PipeWorker.__new__(PipeWorker)
        worker.closed, worker.error = False, ''
        class ClosingQueue(queue.Queue):
            def put_nowait(self, packet):
                # Deterministically model close() winning after the reader's
                # closed check, while its already-full results queue is locked.
                worker.closed = True
                return super().put_nowait(packet)
        worker.results = ClosingQueue(maxsize=1)
        queue.Queue.put(worker.results, {'kind': 'already-queued'}, block=False)
        child = SimpleNamespace(stdout=io.BytesIO())
        calls = []
        def read(stream):
            self.assertFalse(stream.closed)
            calls.append(True)
            if len(calls) <= 3:
                return {'kind': 'inflight-data'}
            raise EOFError('Child released camera and closed stdout')
        with patch('services.eye_tracking.adapters.pupil_native.process._read_packet', side_effect=read):
            worker._read(child)
        self.assertEqual(len(calls), 4, 'Queue.Full closed stdout during parent shutdown')
        self.assertEqual(worker.error, '')
        self.assertEqual(worker.poll(), [{'kind': 'already-queued'}])
        self.assertTrue(child.stdout.closed)

    def test_active_output_queue_overflow_still_reaches_owner(self):
        worker = PipeWorker.__new__(PipeWorker)
        worker.closed, worker.error = False, ''
        worker.results = queue.Queue(maxsize=1)
        worker.results.put_nowait({'kind': 'already-queued'})
        child = SimpleNamespace(stdout=io.BytesIO())
        with patch('services.eye_tracking.adapters.pupil_native.process._read_packet',
                   return_value={'kind': 'overflow'}) as read:
            worker._read(child)
        read.assert_called_once()
        self.assertIn('queue overflow', worker.error)
        self.assertTrue(child.stdout.closed)

    def test_stop_keeps_real_pipe_open_for_camera_final_frames(self):
        script = '''
import sys
from services.eye_tracking.adapters.pupil_core.feature_worker import _write_packet
_write_packet(sys.stdout.buffer, {'kind': 'ready'})
sys.stdin.buffer.read()
for _ in range(3):
    _write_packet(sys.stdout.buffer, {'kind': 'data', 'pixels': b'x' * (1024 * 1024)})
'''
        with tempfile.TemporaryFile() as errors:
            child = subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            diagnostics = threading.Thread(target=lambda: errors.write(child.stderr.read()), daemon=True)
            diagnostics.start()
            worker = PipeWorker.__new__(PipeWorker)
            worker.closed, worker.error, worker.process = False, '', child
            worker.results, worker._lock = queue.Queue(maxsize=1), threading.Lock()
            reader = threading.Thread(target=worker._read, args=(child,), daemon=True)
            reader.start()
            try:
                self.assertEqual(worker.results.get(timeout=5), {'kind': 'ready'})
                worker.close()
                reader.join(2)
                diagnostics.join(2)
                errors.seek(0)
                self.assertEqual(child.returncode, 0, errors.read().decode(errors='replace'))
                self.assertFalse(reader.is_alive())
                self.assertEqual(worker.error, '')
                self.assertTrue(worker.results.empty())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()
                reader.join(2)
                child.stdin.close()
                child.stdout.close()

    def test_prepare_finishes_while_parent_stdin_remains_open(self):
        # A new process is essential: NumPy already imported by other tests
        # cannot reproduce the Windows DLL loading / stdin reader race.
        with tempfile.TemporaryFile() as errors:
            child = subprocess.Popen([sys.executable, '-m', 'services.eye_tracking.entrypoints.pupil_server',
                                      '--native-worker', 'prepare'], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=errors, bufsize=0)
            result = queue.Queue()
            def receive():
                try:
                    result.put(_read_packet(child.stdout))
                except Exception as exc:
                    result.put({'kind': 'error', 'message': str(exc)})
            reader = threading.Thread(target=receive, daemon=True)
            reader.start()
            try:
                _write_packet(child.stdin, {})
                try:
                    packet = result.get(timeout=10)
                except queue.Empty:
                    self.fail('Preparation blocked while parent stdin stayed open')
                self.assertEqual(packet['kind'], 'prepared', packet)
                self.assertIsNone(child.poll(), 'Worker must wait for parent EOF after readiness')
                child.stdin.close()
                self.assertEqual(child.wait(timeout=3), 0)
            finally:
                if not child.stdin.closed:
                    child.stdin.close()
                if child.poll() is None:
                    child.kill()
                    child.wait()
                reader.join(2)
                child.stdout.close()

    def test_import_with_parent_monitor_then_shutdown_or_eof(self):
        script = '''
import sys, threading, time
from services.eye_tracking.infrastructure.pupil_parent_pipe import parent_pipe_reader, wait_for_parent
read = parent_pipe_reader(sys.stdin.buffer)
done = threading.Event()
def monitor():
    wait_for_parent(read, shutdown_command=True)
    done.set()
threading.Thread(target=monitor, daemon=True).start()
time.sleep(.05)
import numpy, scipy.optimize
print('ready', flush=True)
assert done.wait(5), 'parent closure not observed'
'''
        for ending in (b'shutdown\n', b''):
            with self.subTest(ending=ending), tempfile.TemporaryFile() as errors:
                child = subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=errors, bufsize=0)
                result = queue.Queue()
                reader = threading.Thread(target=lambda: result.put(child.stdout.readline()), daemon=True)
                reader.start()
                try:
                    self.assertEqual(result.get(timeout=10).strip(), b'ready')
                    if ending:
                        child.stdin.write(ending)
                        child.stdin.flush()
                    else:
                        child.stdin.close()
                    self.assertEqual(child.wait(timeout=3), 0)
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                    reader.join(2)
                    child.stdin.close()
                    child.stdout.close()
