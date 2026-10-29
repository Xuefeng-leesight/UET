import asyncio
import base64
from concurrent.futures import Future
from dataclasses import replace
import io
import json
import queue
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from services.eye_tracking.transport.huahong_runtime import HuahongWebSocketServer
from services.eye_tracking.application.huahong_runtime import HuahongRuntime
from services.eye_tracking.domain.samples import SampleIdentity, VideoFrame
from services.eye_tracking.infrastructure.huahong_diagnostics import HuahongWatchdog


async def wait_until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.005)


class ControlledSocket:
    """Hold the first send while receiver and publisher fill the real queue."""
    def __init__(self):
        self.request = SimpleNamespace(path='/')
        self.incoming, self.sent = asyncio.Queue(), asyncio.Queue()
        self.send_started, self.release_send = asyncio.Event(), asyncio.Event()

    def __aiter__(self):
        return self

    async def __anext__(self):
        value = await self.incoming.get()
        if value is None:
            raise StopAsyncIteration
        if isinstance(value, Exception):
            raise value
        return value

    async def send(self, message):
        if not self.send_started.is_set():
            self.send_started.set()
            await self.release_send.wait()
        self.sent.put_nowait(message)

    async def close(self, *args):
        pass


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_preview_diagnostics_are_rate_limited_and_keep_stream_generation(self):
        clock = SimpleNamespace(value=100.0)
        identity = SampleIdentity('HH_ET28', 'scene', 1, 1, 99, 99)
        scene = VideoFrame(identity, 'scene', 2, 2, 'bgr', bytes(12), None)
        server = HuahongWebSocketServer(SimpleNamespace())
        server.clients['image'].add(asyncio.Queue(maxsize=1))
        def encode(sample):
            clock.value += .01
            return {'kind': sample.stream}
        with patch('services.eye_tracking.transport.huahong_runtime.time',
                   SimpleNamespace(monotonic=lambda: clock.value)), \
                patch('services.eye_tracking.transport.huahong_runtime.image_payload', side_effect=encode), \
                self.assertLogs(level='INFO') as logs:
            await server._encode_image(scene)
            server._log_preview_health()
            for _ in range(50):
                await server._encode_image(scene)
                server._log_preview_health()
            await server._encode_image(replace(scene, stream='left_eye'))
            clock.value = 106
            server._log_preview_health()
            await server._encode_image(replace(scene, identity=replace(identity, generation=2)))
            server.clients['image'].clear()
            clock.value = 120
            server._log_preview_health()
        first = [line for line in logs.output if 'first_encoded' in line]
        heartbeats = [line for line in logs.output if 'heartbeat' in line]
        self.assertEqual(len(first), 3, 'First frame is logged once per stream and connection')
        self.assertEqual(sum('first_encode_started' in line for line in logs.output), 3)
        self.assertEqual(len(heartbeats), 2, 'Fifty frames must not produce fifty log lines')
        self.assertIn('"encoded": 51', heartbeats[-1])
        self.assertIn('"last_encoded_age_ms": 5490', heartbeats[-1])
        self.assertIn('"last_frame_age_ms": 7000', heartbeats[-1])
        self.assertIn('"source_timestamp_s": 99', heartbeats[-1])
        self.assertEqual(server._preview_stats['scene']['generation'], 2)
        self.assertEqual(server._preview_stats['scene']['encoded'], 1)

    async def test_image_encoding_failure_is_visible_and_does_not_block_command_response(self):
        identity = SampleIdentity('HH_ET28', 'scene', 1, 1, 10, 10)
        frame = VideoFrame(identity, 'scene', 2, 2, 'bgr', bytes(12), None)
        incoming = [frame]
        def request(command, args=None):
            future = Future()
            future.set_result({'type': 'rsp_cmd', 'id': command, 'error': 0})
            return future
        def take_latest():
            frames = tuple(incoming)
            incoming.clear()
            return frames
        runtime = SimpleNamespace(events=queue.Queue(), request=request, take_latest=take_latest)
        server = HuahongWebSocketServer(runtime)
        server.clients['image'].add(asyncio.Queue(maxsize=1))
        socket = ControlledSocket()
        socket.release_send.set()
        client = asyncio.create_task(server._client(socket, 'command'))
        try:
            with patch('services.eye_tracking.transport.huahong_runtime.image_payload',
                       side_effect=ValueError('Invalid frame')), self.assertLogs(level='INFO') as logs:
                with self.assertRaisesRegex(ValueError, 'Invalid frame'):
                    await server._publish()
                await socket.incoming.put(json.dumps({'type': 'req_cmd', 'id': 'get_device_status',
                                                      'args': {'coe': 'private-calibration-data'}}))
                response = json.loads(await asyncio.wait_for(socket.sent.get(), 1))
            self.assertEqual(response['id'], 'get_device_status')
            self.assertEqual(response['error'], 0)
            self.assertEqual(sum('encoding_failed' in line for line in logs.output), 1)
            self.assertEqual(sum('command_received' in line for line in logs.output), 1)
            self.assertEqual(sum('command_completed' in line for line in logs.output), 1)
            self.assertNotIn('private-calibration-data', '\n'.join(logs.output))
        finally:
            await socket.incoming.put(None)
            await asyncio.wait_for(client, 2)

    async def test_blocked_second_encode_reports_stack_while_commands_stay_responsive(self):
        from services.eye_tracking.adapters.huahong.data_normalizer import image_payload
        entered, release, reported = threading.Event(), threading.Event(), threading.Event()
        identity = SampleIdentity('HH_ET28', 'scene', 1, 1, 10, 10)
        frame = VideoFrame(identity, 'scene', 2, 2, 'bgr', bytes(12), None)
        incoming = [frame]
        def request(command, args=None):
            future = Future()
            future.set_result({'type': 'rsp_cmd', 'id': command, 'error': 0})
            return future
        def take_latest():
            frames = tuple(incoming)
            incoming.clear()
            return frames
        calls = 0
        def encode(sample):
            nonlocal calls
            calls += 1
            if calls == 2:
                entered.set()
                if not release.wait(2):
                    raise TimeoutError('Test did not release encoder')
            return image_payload(sample)
        runtime = SimpleNamespace(model='HH_ET28', events=queue.Queue(), request=request, take_latest=take_latest)
        server = HuahongWebSocketServer(runtime)
        watchdog = HuahongWatchdog('HH_ET28', server._preview_watchdog.snapshot, interval_s=.01)
        server._preview_watchdog = watchdog
        phase = watchdog.phase
        pending = asyncio.Queue(maxsize=1)
        server.clients['image'].add(pending)
        socket = ControlledSocket()
        socket.release_send.set()
        client = asyncio.create_task(server._client(socket, 'command'))
        publisher = None
        module = 'services.eye_tracking.infrastructure.huahong_diagnostics'
        with self.assertLogs(level='INFO') as logs, \
                patch('services.eye_tracking.transport.huahong_runtime.image_payload', side_effect=encode), \
                patch.object(watchdog, 'phase', side_effect=lambda name, **_: phase(name, timeout_s=.025)), \
                patch(f'{module}.faulthandler.dump_traceback', side_effect=lambda **_: reported.set()) as dump:
            try:
                publisher = asyncio.create_task(server._publish())
                first = await asyncio.wait_for(pending.get(), 1)
                self.assertEqual(first[0]['source_timestamp_s'], 10)
                incoming.append(replace(frame, identity=replace(identity, received_sequence=2, source_time_s=11)))
                await wait_until(entered.is_set)
                await socket.incoming.put(json.dumps({'type': 'req_cmd', 'id': 'stop', 'args': {}}))
                response = json.loads(await asyncio.wait_for(socket.sent.get(), 1))
                self.assertEqual(response['id'], 'stop')
                self.assertEqual(response['error'], 0)
                await wait_until(reported.is_set)
                self.assertFalse(publisher.done(), 'Diagnostics must not abort the encoding operation')
                self.assertEqual(server._preview_stats['scene']['encoded'], 1)
                release.set()
                second = await asyncio.wait_for(pending.get(), 1)
                self.assertEqual(second[0]['source_timestamp_s'], 11)
                self.assertEqual(server._preview_stats['scene']['encoded'], 2)
            finally:
                release.set()
                if publisher is not None:
                    publisher.cancel()
                    await asyncio.gather(publisher, return_exceptions=True)
                await socket.incoming.put(None)
                await asyncio.wait_for(client, 2)
        dump.assert_called_once_with(all_threads=True)
        warnings = [record.getMessage() for record in logs.records if record.levelname == 'WARNING']
        self.assertEqual(len(warnings), 1)
        self.assertIn('phase=image.encode:scene', warnings[0])
        self.assertIn("'image_clients': 1", warnings[0])
        self.assertTrue(any('phase_finished' in line for line in logs.output))
        self.assertFalse(any('huahong.watchdog heartbeat' in line for line in logs.output))
        self.assertFalse(watchdog._thread.is_alive())

    async def test_slow_image_sender_timeout_is_visible_while_commands_stay_responsive(self):
        def request(command, args=None):
            future = Future()
            future.set_result({'type': 'rsp_cmd', 'id': command, 'error': 0})
            return future
        server = HuahongWebSocketServer(SimpleNamespace(request=request))
        image_socket, command_socket = ControlledSocket(), ControlledSocket()
        command_socket.release_send.set()
        image_client = asyncio.create_task(server._client(image_socket, 'image'))
        command_client = asyncio.create_task(server._client(command_socket, 'command'))
        try:
            await wait_until(lambda: bool(server.clients['image']) and bool(server.clients['command']))
            with self.assertLogs(level='INFO') as logs:
                await next(iter(server.clients['image'])).put(('frame',))
                await asyncio.wait_for(image_socket.send_started.wait(), 1)
                await command_socket.incoming.put(json.dumps({'type': 'req_cmd', 'id': 'stop', 'args': {}}))
                response = json.loads(await asyncio.wait_for(command_socket.sent.get(), 1))
                self.assertEqual(response['id'], 'stop')
                self.assertFalse(image_client.done(), 'Commands complete before the image send times out')
                await asyncio.wait_for(image_client, 3)
            failures = [line for line in logs.output if 'client_failed' in line]
            self.assertEqual(len(failures), 1)
            self.assertIn('kind=image stage=sender error=TimeoutError', failures[0])
            self.assertFalse(server.clients['image'])
        finally:
            image_socket.release_send.set()
            await image_socket.incoming.put(None)
            await command_socket.incoming.put(None)
            await asyncio.wait_for(asyncio.gather(image_client, command_client), 2)

    async def test_receiver_failure_is_logged_once_and_cleans_up_client(self):
        server = HuahongWebSocketServer(SimpleNamespace())
        socket = ControlledSocket()
        await socket.incoming.put(OSError('Socket read failed'))
        with self.assertLogs(level='WARNING') as logs:
            await server._client(socket, 'image')
        self.assertEqual(len(logs.output), 1)
        self.assertIn('kind=image stage=receiver error=OSError', logs.output[0])
        self.assertFalse(server.clients['image'])

    async def test_image_streams_keep_latest_per_kind_for_slow_preview_clients(self):
        from PIL import Image
        identity = SampleIdentity('HH_ET28', 'scene', 1, 1, 10, 10)
        scene = VideoFrame(identity, 'scene', 16, 8, 'bgr', bytes([20]) * (16 * 8 * 3), None)
        left = replace(scene, stream='left_eye', pixels=bytes([70]) * len(scene.pixels))
        right = replace(scene, stream='right_eye', pixels=bytes([190]) * len(scene.pixels))
        incoming = []
        def take_latest():
            result = tuple(incoming)
            incoming.clear()
            return result
        runtime = SimpleNamespace(events=queue.Queue(), take_latest=take_latest)
        server = HuahongWebSocketServer(runtime)
        socket = ControlledSocket()
        client = asyncio.create_task(server._client(socket, 'image'))
        publisher = asyncio.create_task(server._publish())
        try:
            await wait_until(lambda: bool(server.clients['image']))
            pending = next(iter(server.clients['image']))
            incoming.append(scene)
            await asyncio.wait_for(socket.send_started.wait(), 1)
            # The sender is blocked; a pending scene must survive later eye-only batches.
            newer_scene = replace(scene, identity=replace(identity, received_sequence=2, source_time_s=11))
            incoming.append(newer_scene)
            await wait_until(lambda: pending.qsize() == 1)
            incoming.extend((left, right))
            await wait_until(lambda: not incoming)
            # Wait for real JPEG encoding and publisher merge, rather than timing sleeps.
            await wait_until(lambda: pending.qsize() == 1 and len(pending._queue[0]) == 3)
            socket.release_send.set()
            messages = [json.loads(await asyncio.wait_for(socket.sent.get(), 1)) for _ in range(4)]
            current = {message['kind']: message for message in messages[1:]}
            self.assertEqual(set(current), {'scene', 'left_eye', 'right_eye'})
            self.assertEqual(current['scene']['source_timestamp_s'], 11)
            for kind, eye, gray in (('scene', 0, 20), ('left_eye', 1, 70), ('right_eye', 2, 190)):
                message = current[kind]
                self.assertEqual(message['source'], 'HH_ET28')
                self.assertEqual(message['eye'], eye)
                self.assertEqual(message['timestamp_domain'], 'host_arrival')
                decoded = Image.open(io.BytesIO(base64.b64decode(message['data']))).convert('RGB')
                self.assertEqual(decoded.size, (16, 8))
                self.assertTrue(all(abs(value - gray) <= 2 for value in decoded.getpixel((0, 0))))
        finally:
            socket.release_send.set()
            await socket.incoming.put(None)
            await asyncio.wait_for(client, 2)
            publisher.cancel()
            await asyncio.gather(publisher, return_exceptions=True)

    async def test_preview_queue_does_not_merge_a_previous_connection(self):
        identity = SampleIdentity('HH_ET28', 'scene', 2, 1, 10, 10)
        frame = VideoFrame(identity, 'left_eye', 2, 2, 'bgr', bytes(12), None)
        incoming = [frame]
        def take_latest():
            result = tuple(incoming)
            incoming.clear()
            return result
        server = HuahongWebSocketServer(SimpleNamespace(events=queue.Queue(), take_latest=take_latest))
        pending = asyncio.Queue(maxsize=1)
        pending.put_nowait(({'kind': 'scene', 'connection_generation': 1},))
        server.clients['image'].add(pending)
        publisher = asyncio.create_task(server._publish())
        try:
            await wait_until(lambda: pending._queue[0][0]['connection_generation'] == 2)
            self.assertEqual([message['kind'] for message in pending.get_nowait()], ['left_eye'])
        finally:
            publisher.cancel()
            await asyncio.gather(publisher, return_exceptions=True)

    async def test_loopback_command_rejects_foreign_model_and_shuts_down(self):
        from websockets.asyncio.client import connect
        runtime = HuahongRuntime('HH_ET28', '.')
        server = HuahongWebSocketServer(runtime, image_port=0, eye_port=0, command_port=0)
        try:
            await server.start()
            async with connect(f'ws://127.0.0.1:{server.bound_ports[2]}', proxy=None) as socket:
                await socket.send(json.dumps({'type': 'req_cmd', 'id': 'start', 'args': {'sdk_model': 'Pro'}}))
                response = json.loads(await asyncio.wait_for(socket.recv(), 1))
                self.assertEqual(response['error'], -1)
                self.assertIn('new acquisition process', response['msg'])
                await socket.send(json.dumps({'type': 'req_cmd', 'id': 'get_device_status', 'args': {}}))
                response = json.loads(await asyncio.wait_for(socket.recv(), 1))
                self.assertEqual(response['model'], 'HH_ET28')
                self.assertFalse(response['acquisition_ready'])
        finally:
            await server.close()
        self.assertFalse(runtime._thread.is_alive())
        with self.assertRaises(RuntimeError):
            runtime.request('start').result(timeout=1)

    async def test_last_command_disconnect_invalidates_calibration_without_stopping_recording(self):
        from websockets.asyncio.client import connect
        runtime = HuahongRuntime('HH_ET28', '.')
        runtime.service.state = 'ready'
        runtime.service.read = Mock(return_value=[])
        runtime.service.close = Mock()
        recorder = Mock(name='recorder')
        recorder.name = 'recording'
        recorder.finish.return_value = {'status': 'complete'}
        runtime.recorder = recorder
        runtime.verified, runtime.token = True, 'current-calibration'
        server = HuahongWebSocketServer(runtime, image_port=0, eye_port=0, command_port=0)
        sockets = []
        try:
            await server.start()
            url = f'ws://127.0.0.1:{server.bound_ports[2]}'
            sockets = [await connect(url, proxy=None), await connect(url, proxy=None)]
            await wait_until(lambda: len(server.clients['command']) == 2)
            await sockets[0].close()
            await wait_until(lambda: len(server.clients['command']) == 1)
            await sockets[1].send(json.dumps({'type': 'req_cmd', 'id': 'get_recording_status', 'args': {}}))
            response = json.loads(await asyncio.wait_for(sockets[1].recv(), 1))
            self.assertEqual(response['status'], 'recording')
            self.assertTrue(runtime.verified)
            self.assertEqual(runtime.token, 'current-calibration')
            generation = runtime.calibration_generation
            await sockets[1].close()
            await wait_until(lambda: not runtime.verified)
            self.assertEqual(runtime.token, '')
            self.assertEqual(runtime.calibration_generation, generation + 1)
            self.assertIs(runtime.recorder, recorder)
            recorder.finish.assert_not_called()
        finally:
            for socket in sockets:
                await socket.close()
            await server.close()
        self.assertFalse(runtime._thread.is_alive())

    async def test_sender_discards_queued_old_calibration_responses_and_events(self):
        runtime = SimpleNamespace(calibration_generation=1, events=queue.Queue(), take_latest=lambda: ())
        def request(command, args=None):
            result = Future()
            if command == 'cancel_calibration':
                runtime.calibration_generation += 1
            result.set_result({'type': 'rsp_cmd', 'id': command, 'error': 0,
                               'coe': 'old-calibration', '_calibration_generation': runtime.calibration_generation})
            return result
        runtime.request = Mock(side_effect=request)
        server = HuahongWebSocketServer(runtime)
        socket = ControlledSocket()
        client = asyncio.create_task(server._client(socket, 'command'))
        publisher = asyncio.create_task(server._publish())
        try:
            await wait_until(lambda: bool(server.clients['command']))
            pending = next(iter(server.clients['command']))
            old_event = {'type': 'notify_finish', 'index': 1, 'error': 0, '_calibration_generation': 1}
            await pending.put(({'type': 'block'}, old_event))
            await asyncio.wait_for(socket.send_started.wait(), 1)
            await socket.incoming.put(json.dumps({'type': 'req_cmd', 'id': 'complete_calibration', 'args': {}}))
            await wait_until(lambda: pending.qsize() == 1)
            runtime.events.put(old_event)
            await wait_until(lambda: pending.qsize() == 2)
            runtime.calibration_generation = 2
            current_event = {**old_event, 'index': 2, '_calibration_generation': 2}
            runtime.events.put(current_event)
            runtime.events.put({'type': 'sentinel'})
            await wait_until(lambda: pending.qsize() == 3)
            socket.release_send.set()
            messages = [json.loads(await asyncio.wait_for(socket.sent.get(), 1)) for _ in range(3)]
            self.assertEqual(messages, [{'type': 'block'}, {'type': 'notify_finish', 'index': 2, 'error': 0},
                                        {'type': 'sentinel'}])
            self.assertTrue(socket.sent.empty())
            self.assertIn('_calibration_generation', current_event, 'Broadcast payload must not be mutated')
        finally:
            socket.release_send.set()
            await socket.incoming.put(None)
            await asyncio.wait_for(client, 2)
            publisher.cancel()
            await asyncio.gather(publisher, return_exceptions=True)

    async def test_command_disconnect_tolerates_already_stopped_runtime(self):
        def request(command):
            result = Future()
            result.set_exception(RuntimeError('Service shutting down'))
            return result
        runtime = SimpleNamespace(request=Mock(side_effect=request))
        server = HuahongWebSocketServer(runtime)
        socket = ControlledSocket()
        await socket.incoming.put(None)
        await asyncio.wait_for(server._client(socket, 'command'), 1)
        runtime.request.assert_called_once_with('cancel_calibration')
        self.assertFalse(server.clients['command'])
