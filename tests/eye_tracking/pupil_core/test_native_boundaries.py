"""Native lifecycle, actual detector interfaces, and scientific export boundaries."""
from dataclasses import asdict
import io
import asyncio
import json
import math
import os
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

import numpy as np

from services.eye_tracking.adapters.pupil_native.config import NativeConfig
from services.eye_tracking.adapters.pupil_native.source import NativeSource, message
from services.eye_tracking.adapters.pupil_native.process import PipeWorker
from services.eye_tracking.adapters.pupil_native.preparation import NativePreparation, load_dependencies
from services.eye_tracking.adapters.pupil_native.events import NativeEvents
from services.eye_tracking.adapters.pupil_native.saccades import Saccades
from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.adapters.pupil_core.feature_worker import _read_packet, _write_packet
from services.eye_tracking.adapters.pupil_core.network import NetworkConfig
from services.eye_tracking.application.pupil_runtime import PupilRuntime
from services.eye_tracking.infrastructure.pupil_events import event_rows
from tests.eye_tracking.pupil_core.test_native import FakeWorker, observations


def gaze(stamp, degrees=0):
    angle = math.radians(degrees)
    return dict(timestamp=stamp, confidence=1., norm_pos=[.5 + degrees / 100, .5],
                gaze_point_3d=[500 * math.sin(angle), 0, 500 * math.cos(angle)],
                eye_center_3d=[0, 0, 0], world_resolution=[1280, 720])


class NativeBoundaryTests(unittest.TestCase):
    def test_disconnect_cancellation_survives_full_queue_and_ignores_old_request(self):
        runtime = PupilRuntime(NetworkConfig(), source=NativeSource(worker_factory=FakeWorker), prepare_native=True)
        runtime.start()
        release = threading.Event()
        blocked = threading.Event()
        def hold_owner():
            blocked.set()
            if not release.wait(2):
                raise TimeoutError('Test failed to release acquisition owner')
        try:
            pending = runtime.request('start')
            runtime.request('get_device_status').result(2)
            with patch.object(runtime, '_collect', side_effect=hold_owner):
                self.assertTrue(blocked.wait(2))
                queued = runtime.request('start')
                statuses = [runtime.request('get_device_status') for _ in range(15)]
                self.assertTrue(runtime.requests.full())
                runtime.cancel_start(pending)
                runtime.cancel_start(queued)
                release.set()
                self.assertEqual(pending.result(2)['error'], -1)
                self.assertTrue(queued.cancelled())
                for status in statuses:
                    status.result(2)
            newer = runtime.request('start')
            runtime.request('get_device_status').result(2)
            runtime.cancel_start(pending)
            runtime.request('get_device_status').result(2)
            self.assertFalse(newer.done(), 'Old disconnect canceled a newer request')
            runtime.request('stop').result(2)
            self.assertEqual(newer.result(2)['error'], -1)
            self.assertFalse(runtime.service.network.workers)
        finally:
            release.set()
            runtime.close()

    def test_preparing_start_can_stop_on_same_socket_and_disconnect_revokes_it(self):
        from websockets.asyncio.client import connect
        from services.eye_tracking.transport.pupil_runtime import PupilWebSocketServer
        async def scenario():
            runtime = PupilRuntime(NetworkConfig(), source=NativeSource(worker_factory=FakeWorker), prepare_native=True)
            server = PupilWebSocketServer(runtime, image_port=0, eye_port=0, command_port=0)
            await server.start()
            url = f'ws://127.0.0.1:{server.bound_ports[2]}'
            try:
                async with connect(url, proxy=None) as ws:
                    for command in ('start', 'get_device_status', 'stop'):
                        await ws.send(json.dumps({'type': 'req_cmd', 'id': command}))
                    replies = [json.loads(await asyncio.wait_for(ws.recv(), 2)) for _ in range(3)]
                    by_id = {r['id']: r for r in replies}
                    self.assertEqual(by_id['stop']['error'], 0)
                    self.assertEqual(by_id['start']['error'], -1)
                    self.assertFalse(by_id['get_device_status']['algorithm_ready'])
                    await ws.send(json.dumps({'type': 'req_cmd', 'id': 'start'}))
                    await ws.send(json.dumps({'type': 'req_cmd', 'id': 'get_device_status'}))
                    self.assertEqual(json.loads(await asyncio.wait_for(ws.recv(), 2))['id'], 'get_device_status')
                deadline = time.monotonic() + 2
                while runtime._pending_start is not None:
                    self.assertLess(time.monotonic(), deadline)
                    await asyncio.sleep(.01)
                runtime.preparation.worker.items.append({'kind': 'prepared'})
                while not runtime.preparation.ready:
                    self.assertLess(time.monotonic(), deadline)
                    await asyncio.sleep(.01)
                self.assertFalse(runtime.service.network.workers, 'Disconnected request reopened cameras')
            finally:
                await server.close()
        asyncio.run(scenario())

    def test_library_preparation_keeps_commands_responsive_and_never_opens_cameras(self):
        created = []
        def factory(*args, **kwargs):
            worker = FakeWorker(*args, **kwargs)
            created.append(worker)
            return worker
        runtime = PupilRuntime(NetworkConfig(), source=NativeSource(worker_factory=factory), prepare_native=True)
        runtime.start()
        try:
            status = runtime.request('get_device_status').result(2)
            self.assertFalse(status['algorithm_ready'])
            pending = runtime.request('start')
            runtime.request('get_device_status').result(2)
            self.assertFalse(pending.done())
            self.assertEqual(runtime.request('start').result(2)['error'], -1)
            self.assertEqual(runtime.request('stop').result(2)['error'], 0)
            self.assertEqual(pending.result(2)['error'], -1)
            self.assertEqual([worker.kind for worker in created], ['prepare'])
            self.assertFalse(created[0].closed)
            created[0].items.append({'kind': 'prepared'})
            deadline = time.monotonic() + 2
            while not runtime.request('get_device_status').result(2)['algorithm_ready']:
                self.assertLess(time.monotonic(), deadline)
            self.assertTrue(created[0].closed)
            self.assertEqual(runtime.service.state, 'disconnected')
        finally:
            runtime.close()
        with patch('uvc.device_list', side_effect=AssertionError('Preparation enumerated devices')), \
             patch('uvc.Capture', side_effect=AssertionError('Preparation opened a camera')):
            load_dependencies()

    def test_start_waits_for_preparation_then_connects_without_retry(self):
        created = []
        def factory(*args, **kwargs):
            worker = FakeWorker(*args, **kwargs)
            created.append(worker)
            return worker
        runtime = PupilRuntime(NetworkConfig(), source=NativeSource(worker_factory=factory), prepare_native=True)
        runtime.start()
        try:
            pending = runtime.request('start')
            runtime.request('get_device_status').result(2)
            self.assertFalse(pending.done())
            self.assertEqual([w.kind for w in created], ['prepare'])
            created[0].items.append({'kind': 'prepared'})
            deadline = time.monotonic() + 2
            while runtime.request('get_device_status').result(2)['state'] != 'connecting':
                self.assertLess(time.monotonic(), deadline)
            self.assertEqual([w.kind for w in created], ['prepare', 'camera', 'camera', 'camera'])
            self.assertFalse(pending.done(), 'Library readiness must not count as camera readiness')
            runtime.request('stop').result(2)
            self.assertEqual(pending.result(2)['error'], -1)
        finally:
            runtime.close()

    def test_preparation_pending_start_failure_timeout_and_shutdown(self):
        for ending in ('error', 'timeout', 'shutdown'):
            with self.subTest(ending=ending):
                runtime = PupilRuntime(NetworkConfig(), source=NativeSource(worker_factory=FakeWorker), prepare_native=True)
                runtime.start()
                try:
                    pending = runtime.request('start')
                    runtime.request('get_device_status').result(2)
                    if ending == 'error':
                        runtime.preparation.worker.items.append({'kind': 'error', 'message': 'missing dependency'})
                    elif ending == 'timeout':
                        runtime._pending_prepare_start = 0
                    else:
                        runtime.close()
                    self.assertEqual(pending.result(2)['error'], -1)
                    self.assertFalse(runtime.service.network.workers)
                    self.assertIsNone(runtime._pending_prepare_start)
                finally:
                    if ending != 'shutdown':
                        runtime.close()

    def test_library_preparation_failure_timeout_and_shutdown_release_worker(self):
        for packet in ({'kind': 'error', 'message': 'missing native dependency'}, None):
            prep = NativePreparation(FakeWorker)
            worker = prep.worker
            if packet:
                worker.items.append(packet)
            else:
                prep.deadline = 0
            prep.poll()
            self.assertTrue(prep.error)
            self.assertFalse(prep.ready)
            self.assertTrue(worker.closed)
        created = []
        def factory(*args, **kwargs):
            worker = FakeWorker(*args, **kwargs)
            created.append(worker)
            return worker
        runtime = PupilRuntime(NetworkConfig(), source=NativeSource(worker_factory=factory), prepare_native=True)
        runtime.start()
        runtime.request('get_device_status').result(2)
        runtime.close()
        self.assertEqual([worker.kind for worker in created], ['prepare'])
        self.assertTrue(created[0].closed)

    def test_pending_start_is_cancelable_and_reconnectable(self):
        created = []
        def factory(*args, **kwargs):
            worker = FakeWorker(*args, **kwargs)
            created.append(worker)
            return worker
        source = NativeSource(worker_factory=factory)
        runtime = PupilRuntime(NetworkConfig(), source=source)
        runtime.start()
        try:
            for _ in range(2):
                start = runtime.request('start')
                status = runtime.request('get_device_status').result(2)
                self.assertEqual(status['state'], 'connecting')
                self.assertFalse(start.done())
                self.assertEqual(runtime.request('start').result(2)['error'], -1)
                self.assertEqual(runtime.request('stop').result(2)['error'], 0)
                self.assertEqual(start.result(2)['error'], -1)
                self.assertTrue(all(w.closed for w in created))
                self.assertFalse(runtime.service.calibration.verified)
        finally:
            runtime.close()

    def test_initialization_failure_releases_owner(self):
        source = NativeSource(NativeConfig(intrinsics_path='/nonexistent/mrt-test-camera.json'), worker_factory=FakeWorker)
        with self.assertRaises(FileNotFoundError):
            source.open()
        self.assertIsNone(source._owner)
        self.assertFalse(source.workers)

    def test_late_process_launch_is_disposed_after_cancel(self):
        entered, release = threading.Event(), threading.Event()
        original = subprocess.Popen
        children = []
        def delayed(*args, **kwargs):
            entered.set()
            release.wait(3)
            child = original(*args, **kwargs)
            children.append(child)
            return child
        with patch('services.eye_tracking.adapters.pupil_native.process.subprocess.Popen', side_effect=delayed):
            worker = PipeWorker('fit', {})
            self.assertTrue(entered.wait(2))
            worker.close()
            release.set()
            worker._threads[0].join(3)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertIsNone(worker.process)

    def test_overflow_is_explicit_and_disconnect_revokes_fit(self):
        payload = io.BytesIO()
        _write_packet(payload, {'kind': 'data'})
        _write_packet(payload, {'kind': 'data'})
        payload.seek(0)
        worker = PipeWorker.__new__(PipeWorker)
        import queue
        worker.results, worker.closed, worker.error = queue.Queue(maxsize=1), False, ''
        class Child:
            stdout = payload
        worker._read(Child())
        self.assertIn('overflow', worker.error)
        source = NativeSource(worker_factory=FakeWorker)
        from services.eye_tracking.adapters.pupil_core.service import PupilService
        service = PupilService(source=source)
        service.begin_connect()
        source.workers[0].error = worker.error
        with self.assertRaisesRegex(RuntimeError, 'overflow'):
            service.poll_connect()
        self.assertEqual(service.state, 'failed')
        self.assertFalse(service.calibration.verified)
        self.assertFalse(source.workers)

    def test_actual_detectors_in_camera_loop_and_release(self):
        import cv2
        import uvc
        from services.eye_tracking.adapters.pupil_native.worker import camera_loop
        devices = [{'name': f'Pupil Cam3 ID{i}', 'uid': str(i)} for i in range(3)]
        class Camera:
            frame_sizes = [(192, 192), (1280, 720)]
            frame_rates = [30, 120]
            controls = []
            closed = False
            def get_frame(self, timeout):
                class Frame:
                    timestamp = uvc.get_time_monotonic()
                    index = 1
                    gray = np.full((192, 192), 150, dtype=np.uint8)
                    cv2.ellipse(gray, (96, 96), (30, 22), 0, 0, 360, 10, -1)
                    bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
                return Frame()
            def close(self):
                self.closed = True
        cap, stop, packets = Camera(), threading.Event(), []
        def emit(value):
            packets.append(value)
            if value['kind'] == 'data':
                stop.set()
        with patch.object(uvc, 'device_list', return_value=devices), patch.object(uvc, 'Capture', return_value=cap):
            camera_loop({'role': 0, 'eye_fps': 120, 'world_fps': 30}, stop, emit)
        self.assertTrue(cap.closed)
        self.assertEqual(packets[0]['kind'], 'ready')
        topics = [v['payload']['topic'] for v in packets[1]['items']]
        self.assertEqual(topics, ['pupil.0.2d', 'pupil.0.3d', 'frame.eye.0'])
        for item in packets[1]['items'][:2]:
            DataNormalizer().normalize(message(item['payload']), 1, 1)

    def test_fixations_blinks_saccades_and_gaps(self):
        events = NativeEvents()
        phases = []
        for i in range(100):
            phases.extend(events.pupil({'id': 0, 'timestamp': i * .01,
                                        'confidence': 0 if 30 <= i < 45 else 1}))
        self.assertEqual([v['type'] for v in phases], ['onset', 'offset'])
        fixes = [f for i in range(25) for f in events.fixation(gaze(i * .01))]
        self.assertTrue(fixes)
        self.assertEqual({f['id'] for f in fixes}, {1})
        interrupted = events.fixation(gaze(1))
        self.assertEqual(len(interrupted), 1)
        self.assertFalse(interrupted[0]['event_complete'])
        self.assertEqual(interrupted[0]['event_completion_reason'], 'sampling_gap')
        saccades = Saccades()
        result = [e for i, a in enumerate([0, 0, 1, 2, 3, 3]) for e in saccades.push(gaze(i * .01, a))]
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0]['duration'], 30)
        self.assertAlmostEqual(result[0]['metrics']['saccade_endpoint_distance_deg'], 3)
        self.assertAlmostEqual(result[0]['metrics']['average_saccade_velocity_deg_ms'], .1)
        self.assertNotIn('saccade_distance_deg', result[0]['metrics'])
        saccades.push(gaze(.06, 4))
        saccades.push(dict(gaze(.07, 5), confidence=0))
        self.assertEqual(saccades.push(gaze(.08, 5)), [])
        sample = DataNormalizer().normalize(message(result[0]), 1, 1)
        rows, _ = event_rows([json.dumps(asdict(sample)) + '\n'], 0, 1)
        self.assertEqual(rows[0]['saccade_distance_px'], '')  # no flanking fixations
        self.assertGreater(rows[0]['saccade_endpoint_distance_px'], 0)

    def test_long_fast_motion_is_not_split_into_a_short_saccade_tail(self):
        saccades = Saccades()
        events = [event for i in range(71) for event in saccades.push(gaze(i * .01, i * .4))]
        events.extend(saccades.push(gaze(.71, 28)))
        self.assertEqual(events, [])
        # A distinct movement after a slow interval remains detectable.
        events = [event for i, angle in enumerate([28.4, 28.8, 29.2, 29.2], 72)
                  for event in saccades.push(gaze(i * .01, angle))]
        self.assertEqual(len(events), 1)

    @unittest.skipUnless(os.environ.get('MRT_PUPIL_EXECUTABLE'), 'Set target-platform packaged executable')
    def test_packaged_native_fit_without_python_environment(self):
        spec, refs, pupils = observations()
        source = io.BytesIO()
        _write_packet(source, {'request_id': 'packaged-test', 'refs': refs, 'pupils': pupils, 'intrinsics': spec})
        result = subprocess.run([os.environ['MRT_PUPIL_EXECUTABLE'], '--native-worker', 'fit'],
                                input=source.getvalue(), capture_output=True, timeout=NativeSource.fit_timeout_s)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
        packet = _read_packet(io.BytesIO(result.stdout))
        self.assertEqual(packet['kind'], 'fit', packet)
        self.assertLess(packet['params']['training_mean_error_normalized'], .001)
        angular = packet['params']['training_angular']
        self.assertFalse(angular['independentValidationPerformed'])
        for metric in angular['metrics'].values():
            self.assertGreater(metric['samples'], 0)
            self.assertLess(metric['meanErrorDeg'], .1)
            self.assertIsNotNone(metric['pupilCoreAccuracyDeg'])
            self.assertGreaterEqual(metric['qualityScore'], 9.8)
            self.assertEqual(metric['scoringPolicy'], 'mrt_angular_linear_v1')
