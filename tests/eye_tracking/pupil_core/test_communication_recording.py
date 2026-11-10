"""Communication records remain distinct, durable, and bound to one video clock."""
import csv
import base64
from concurrent.futures import Future
from dataclasses import replace
import io
import json
from pathlib import Path
import shutil
import tempfile
import time
from types import SimpleNamespace
import unittest

from services.eye_tracking.adapters.pupil_core.network import NetworkConfig
from services.eye_tracking.application.pupil_runtime import PupilRuntime
from services.eye_tracking.infrastructure.pupil_csv import CSV_FIELDS
from services.eye_tracking.infrastructure.pupil_recorder import PupilRecorder, RecordingError
from services.eye_tracking.infrastructure.pupil_recovery import recover_directory
from services.eye_tracking.infrastructure.recording_communication import (
    COMMUNICATION_CHANNELS, append_communications, communication_capture_status, validate_communication,
)
from services.eye_tracking.transport.pupil_runtime import PupilWebSocketServer
from .test_recording import frame, gaze


def envelope(text):
    return json.dumps({'encoding': 'utf-8', 'data': text}, ensure_ascii=False)


def event(channel='udp_send', stamp=100., text='42', event_id='message_1', recording_id='communications', generation=1):
    return dict(recording_id=recording_id, generation=generation, event_id=event_id,
                channel=channel, text=envelope(text), video_time_ms=stamp)


def runtime_for(recorder):
    runtime = PupilRuntime(NetworkConfig())
    runtime.recorder = recorder
    runtime.service = SimpleNamespace(state='ready', generation=1,
                                      network=SimpleNamespace(source_time=lambda: 10.5))
    return runtime


class CommunicationValidationTests(unittest.TestCase):
    def test_capture_status_identity_and_clean_stop_are_required_when_present(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'communication-capture-status.json'
            self.assertEqual(communication_capture_status(temp, 'communications', 1), {})
            value = dict(recording_id='communications', generation=1, status='stopped', errors=[], clock_uncertainty_ms=2.5)
            path.write_text(json.dumps(value))
            result = communication_capture_status(temp, 'communications', 1)
            self.assertEqual(result['communicationCaptureErrors'], [])
            self.assertEqual(result['communicationClockUncertaintyMs'], 2.5)
            for changed in (dict(status='recording'), dict(status='error'), dict(errors=['serial failure']),
                            dict(generation=2), dict(recording_id='other'), dict(errors='invalid'),
                            dict(clock_uncertainty_ms=float('nan'))):
                with self.subTest(changed=changed):
                    path.write_text(json.dumps({**value, **changed}))
                    self.assertTrue(communication_capture_status(temp, 'communications', 1)['communicationCaptureErrors'])
            path.write_text('{"torn":')
            self.assertEqual(communication_capture_status(temp, 'communications', 1)['communicationCaptureStatus'], 'invalid')

    def test_invalid_identity_channel_text_and_time_are_rejected(self):
        changes = [dict(recording_id='other'), dict(generation=2), dict(generation=True),
                   dict(event_id=''), dict(event_id='../elsewhere'), dict(channel='triggerMark'),
                   dict(text=42), dict(text=envelope('x' * 65537)), dict(text='not-json'), dict(video_time_ms=-1),
                   dict(video_time_ms=float('nan')), dict(video_time_ms=float('inf')), dict(video_time_ms=True)]
        for change in changes:
            with self.subTest(change=list(change)), self.assertRaises(ValueError):
                validate_communication({**event(), **change}, 'communications', 1)

    def test_control_text_is_reversible_and_does_not_split_csv_lines(self):
        for text in ('', 'line one\r\nline two\t\0', '中文, "quoted"', 'plain text'):
            with self.subTest(text=text):
                cell = envelope(text)
                validate_communication({**event(), 'text': cell}, 'communications', 1)
                if not text or any(ord(c) < 32 for c in text):
                    self.assertEqual(json.loads(cell)['data'], text)
                    self.assertNotIn('\n', cell)
                else:
                    self.assertEqual(json.loads(cell)['data'], text)
                output = io.StringIO()
                csv.writer(output).writerow([cell])
                self.assertEqual(next(csv.reader(io.StringIO(output.getvalue()))), [cell])

    def test_binary_empty_and_max_payload_envelopes_preserve_bytes_and_reject_malformed_encoding(self):
        for payload in (b'', b'\xff\x00\xfe', bytes(range(256)) * 256):
            text = json.dumps({'encoding': 'base64', 'data': base64.b64encode(payload).decode('ascii')})
            self.assertEqual(validate_communication({**event(), 'text': text}, 'communications', 1)['text'], text)
        invalid = [json.dumps({'encoding': 'base64', 'data': '%%%'}),
                   json.dumps({'encoding': 'base64', 'data': 'YQ'}),
                   json.dumps({'encoding': 'unknown', 'data': 'value'}),
                   '{"encoding":"utf-8","data":"\\ud800"}',
                   '{\n"encoding":"utf-8","data":"value"}',
                   json.dumps({'encoding': 'utf-8', 'data': 123})]
        for text in invalid:
            with self.subTest(text=text), self.assertRaises(ValueError):
                validate_communication({**event(), 'text': text}, 'communications', 1)

    def test_recovery_mapper_clips_video_range_deduplicates_and_ignores_only_torn_tail(self):
        with tempfile.TemporaryDirectory() as temp:
            journal = Path(temp) / 'communication-events.jsonl'
            payloads = [event(), event(), event(stamp=1000, event_id='after_video')]
            journal.write_text(''.join(json.dumps(item) + '\n' for item in payloads) + '{"torn":')
            output = io.StringIO()
            csv.DictWriter(output, fieldnames=CSV_FIELDS).writeheader()
            counts = append_communications(journal, output, 1, 'communications', 1, 10)
            rows = list(csv.DictReader(io.StringIO(output.getvalue())))
            self.assertEqual(counts, {'communicationEvents': 1, 'communicationOutsideVideo': 1})
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['udp_send'], envelope('42'))
            self.assertEqual(rows[0]['source_timestamp_s'], '10.1')
            self.assertEqual(rows[0]['source_event_type'], 'communication')
            self.assertEqual(rows[0]['triggerMark'], '')
            self.assertEqual(rows[0]['recom_gaze_bit_mask'], '')
            journal.write_text(json.dumps(event()) + '\n' + json.dumps(event(text='different')) + '\n')
            with self.assertRaisesRegex(ValueError, 'Conflicting'):
                append_communications(journal, io.StringIO(), 1, 'communications', 1, 10)

    def test_capture_only_journal_retains_unacknowledged_events_and_deduplicates_both_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            journal = Path(temp) / 'communication-events.jsonl'
            capture = Path(temp) / 'communication-capture.jsonl'
            delivered = event('udp_receive', text='acknowledged', event_id='delivered')
            unacknowledged = event('trigger_receive', 200, 'WS disconnected', 'pending')
            capture.write_text(json.dumps(delivered) + '\n' + json.dumps(unacknowledged) + '\n')
            counts = append_communications(journal, io.StringIO(), 1, 'communications', 1, 10)
            self.assertEqual(counts['communicationEvents'], 2, 'Capture journal alone survives command loss')
            journal.write_text(json.dumps(delivered) + '\n' + '{"torn":')
            counts = append_communications(journal, io.StringIO(), 1, 'communications', 1, 10)
            self.assertEqual(counts['communicationEvents'], 2, 'ACK journal cannot duplicate the captured packet')
            capture.write_text(json.dumps({**delivered, 'text': envelope('conflict')}) + '\n')
            with self.assertRaisesRegex(ValueError, 'Conflicting'):
                append_communications(journal, io.StringIO(), 1, 'communications', 1, 10)
            capture.write_text(json.dumps({**unacknowledged, 'recording_id': 'another_recording'}) + '\n')
            with self.assertRaisesRegex(ValueError, 'another recording'):
                append_communications(journal, io.StringIO(), 1, 'communications', 1, 10)


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class CommunicationRecordingTests(unittest.TestCase):
    def start_recorder(self, temp):
        recorder = PupilRecorder(Path(temp), 'communications', frame(), fps=10)
        recorder.start()
        recorder.submit([gaze(10.15), frame(10.3, 2)])
        self.addCleanup(recorder.finish)
        return recorder

    def test_four_direction_columns_runtime_to_real_csv_keep_original_content(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = self.start_recorder(temp)
            runtime = runtime_for(recorder)
            values = ['outgoing,udp', '收到 UDP', 'serial\r\n', 'serial response']
            for index, (channel, text) in enumerate(zip(COMMUNICATION_CHANNELS, values)):
                response = runtime._command('record_communication', event(channel, 50 + 50 * index, text, f'e_{index}'))
                self.assertTrue(response['recorded'])
                self.assertFalse(response['duplicate'])
            duplicate = runtime._command('record_communication', event('udp_send', 50, values[0], 'e_0'))
            self.assertTrue(duplicate['duplicate'])
            with self.assertRaisesRegex(RecordingError, 'Conflicting'):
                runtime._command('record_communication', event('udp_send', 50, 'different', 'e_0'))
            journal = [json.loads(line) for line in (recorder.sidecar / 'communication-events.jsonl').read_text().splitlines()]
            self.assertEqual([item['text'] for item in journal], [envelope(value) for value in values], 'Durable journal contains exact source text')
            result = recorder.finish()
            self.assertEqual(result['status'], 'complete', result)
            self.assertEqual(result['communicationEvents'], 4)
            self.assertEqual(result['gazeRows'], 1, 'Communication rows never inflate gaze validity/rate')
            with recorder.csv_path.open(newline='') as handle:
                rows = list(csv.DictReader(handle))
            events = [row for row in rows if row['source_event_type'] == 'communication']
            self.assertEqual(len(events), 4)
            for index, row in enumerate(events):
                channel = COMMUNICATION_CHANNELS[index]
                self.assertEqual(row[channel], envelope(values[index]))
                self.assertTrue(all(row[other] == '' for other in COMMUNICATION_CHANNELS if other != channel))
                self.assertEqual(row['video_time_ms'], str(50 + 50 * index))
                self.assertEqual(row['communication_recording_id'], 'communications')
                self.assertEqual(row['triggerMark'], '')
            self.assertEqual([float(r['video_time_ms']) for r in rows], sorted(float(r['video_time_ms']) for r in rows))
            with self.assertRaisesRegex(RecordingError, 'active recording'):
                runtime._command('record_communication', event(event_id='after_stop'))

    def test_runtime_rejects_wrong_recording_generation_future_stop_and_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = self.start_recorder(temp)
            runtime = runtime_for(recorder)
            for changed in (dict(recording_id='old_record'), dict(generation=2), dict(video_time_ms=501)):
                with self.subTest(changed=changed), self.assertRaises(ValueError):
                    runtime._command('record_communication', {**event(), **changed})
            runtime.service.generation = 2
            with self.assertRaisesRegex(RuntimeError, 'cross connection'):
                runtime._command('record_communication', event(generation=2))
            runtime.service.generation = 1
            runtime.service.state = 'failed'
            with self.assertRaisesRegex(RuntimeError, 'active connected'):
                runtime._command('record_communication', event())
            runtime.service.state = 'ready'
            runtime.finalizer = object()
            with self.assertRaisesRegex(RuntimeError, 'active connected'):
                runtime._command('record_communication', event())
            runtime.finalizer = None
            recorder._set_error('encoder stopped')
            with self.assertRaisesRegex(RecordingError, 'encoder stopped'):
                runtime._command('record_communication', event())
            self.assertEqual((recorder.sidecar / 'communication-events.jsonl').read_text(), '')
            recorder.finish()

    def test_source_clock_never_pairs_stale_recording_identity_with_new_connection(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = self.start_recorder(temp)
            runtime = runtime_for(recorder)
            runtime.recording_info = dict(recording_id=recorder.name, source_time_origin_s=recorder.timeline.t0)
            self.assertEqual(runtime._command('get_source_clock', {})['generation'], 1)
            runtime.service.generation = 2
            with self.assertRaisesRegex(RuntimeError, 'cross recording or connection'):
                runtime._command('get_source_clock', {})
            runtime.service.generation = 1
            runtime.recording_info['recording_id'] = 'old_recording'
            with self.assertRaisesRegex(RuntimeError, 'cross recording or connection'):
                runtime._command('get_source_clock', {})
            runtime.recording_info['recording_id'] = recorder.name
            runtime.finalizer = object()
            with self.assertRaisesRegex(RuntimeError, 'active connected'):
                runtime._command('get_source_clock', {})
            runtime.finalizer = None
            recorder.finish()
            with self.assertRaisesRegex(RuntimeError, 'active connected'):
                runtime._command('get_source_clock', {})
            runtime.recorder = None
            with self.assertRaisesRegex(RuntimeError, 'active connected'):
                runtime._command('get_source_clock', {})

    def test_recovery_reuses_durable_communication_events_without_modifying_original_csv(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = self.start_recorder(temp)
            # The I/O owner durably captured this packet, but its WS command
            # never arrived. Finalization and crash recovery must both retain it.
            (recorder.sidecar / 'communication-capture.jsonl').write_text(
                json.dumps(event('udp_receive', 100, 'persistent message')) + '\n')
            self.assertEqual(recorder.finish()['status'], 'complete')
            original_csv = recorder.csv_path.read_bytes()
            metadata = json.loads(recorder.meta_path.read_text())
            metadata['status'] = 'recording'  # Simulate loss before finalized metadata was installed.
            recorder.meta_path.write_text(json.dumps(metadata))
            with (recorder.sidecar / 'communication-events.jsonl').open('a') as handle:
                handle.write('{"torn":')
            self.assertEqual(recover_directory(temp), [{'recording_id': 'communications', 'status': 'partial'}])
            self.assertEqual((recorder.sidecar / 'interrupted.csv').read_bytes(), original_csv)
            with recorder.csv_path.open(newline='') as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual([row['udp_receive'] for row in rows if row['udp_receive']], [envelope('persistent message')])
            metadata = json.loads(recorder.meta_path.read_text())
            self.assertEqual(metadata['communicationEvents'], 1)
            self.assertEqual(metadata['gazeRows'], 1)
            self.assertEqual(recover_directory(temp), [])

    def test_io_error_or_unclosed_capture_preserves_data_but_never_claims_complete(self):
        for status, errors in (('error', ['UDP receive socket failed']), ('recording', []), ('stopped', [])):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temp:
                recorder = self.start_recorder(temp)
                runtime_for(recorder)._command('record_communication', event())
                (recorder.sidecar / 'communication-capture-status.json').write_text(json.dumps(dict(
                    recording_id='communications', generation=1, status=status, errors=errors, clock_uncertainty_ms=1.5)))
                result = recorder.finish()
                self.assertEqual(result['status'], 'complete' if status == 'stopped' else 'partial', result)
                self.assertTrue(result['videoVerified'])
                self.assertEqual(result['communicationEvents'], 1)
                self.assertEqual(result['communicationCaptureStatus'], status)
                self.assertEqual(bool(result['communicationCaptureErrors']), status != 'stopped')
                if status != 'stopped':
                    self.assertIn('Communication capture incomplete', result['error'])
                self.assertEqual(json.loads((recorder.sidecar / 'diagnostics.json').read_text())['status'], result['status'])
                # A crash before installing final metadata still recovers the saved
                # data and reports the original I/O failure in both metadata files.
                metadata = json.loads(recorder.meta_path.read_text())
                metadata['status'] = 'recording'
                recorder.meta_path.write_text(json.dumps(metadata))
                self.assertEqual(recover_directory(temp), [{'recording_id': 'communications', 'status': 'partial'}])
                metadata = json.loads(recorder.meta_path.read_text())
                self.assertEqual(metadata['communicationCaptureStatus'], status)
                self.assertEqual(metadata['communicationEvents'], 1)
                self.assertEqual(json.loads((recorder.sidecar / 'diagnostics.json').read_text())['communicationCaptureErrors'], metadata['communicationCaptureErrors'])
                if status != 'stopped':
                    self.assertIn('communication capture incomplete', metadata['error'])

    def test_capture_runtime_records_measured_motion_through_selected_mapper(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = runtime_for(None)
            runtime.service.network.version = '3.5.1'
            runtime.service.calibration = SimpleNamespace(verified=True, snapshot=lambda: {'independentValidationPerformed': False})
            runtime.world = replace(frame(), identity=replace(frame().identity, received_monotonic_s=time.monotonic()))
            runtime.tracking = True
            runtime.paths = SimpleNamespace(directory=lambda _: Path(temp))
            started = runtime._command('start_recording', {'project_path': temp, 'video_sampling_rate_hz': 10})
            recorder = runtime.recorder
            self.assertEqual(started['communication_journal_path'], str(recorder.sidecar / 'communication-capture.jsonl'))
            self.assertTrue(Path(started['communication_journal_path']).is_file())
            try:
                recorder.submit([replace(gaze(10.05), position=(.25, .5), world_resolution=(16, 16)),
                                 replace(gaze(10.06), position=(.5, .5), world_resolution=(16, 16)), frame(10.1, 2)])
            finally:
                result = recorder.finish()
            self.assertEqual(result['status'], 'complete', result)
            with recorder.csv_path.open(newline='') as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]['gaze_velocity_px_ms'], '')
            self.assertAlmostEqual(float(rows[1]['gaze_velocity_px_ms']), .4)
            self.assertEqual(rows[1]['source_backend'], 'capture')


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class CommunicationWebSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_command_endpoint_accepts_maximum_udp_envelope_and_rejects_stale_recording(self):
        from websockets.asyncio.client import connect
        with tempfile.TemporaryDirectory() as temp:
            recorder = PupilRecorder(Path(temp), 'communications', frame(), fps=10)
            recorder.start()
            recorder.submit([frame(10.3, 2)])
            runtime = runtime_for(recorder)
            runtime.start = lambda: None
            runtime.close = lambda: None

            def request(command, args):
                future = Future()
                try:
                    future.set_result({'type': 'rsp_cmd', 'id': command, 'error': 0,
                                       **runtime._command(command, args)})
                except Exception as exc:
                    future.set_result({'type': 'rsp_cmd', 'id': command, 'error': -1, 'msg': str(exc)})
                return future

            runtime.request = request
            server = PupilWebSocketServer(runtime, image_port=0, eye_port=0, command_port=0)
            try:
                await server.start()
                async with connect(f'ws://127.0.0.1:{server.bound_ports[2]}', proxy=None) as socket:
                    payload = event('udp_receive', text='\0' * 65507)
                    await socket.send(json.dumps({'type': 'req_cmd', 'id': 'record_communication', 'args': payload}))
                    self.assertEqual(json.loads(await socket.recv())['error'], 0)
                    await socket.send(json.dumps({'type': 'req_cmd', 'id': 'record_communication',
                                                  'args': {**payload, 'recording_id': 'stale_recording'}}))
                    self.assertEqual(json.loads(await socket.recv())['error'], -1)
            finally:
                await server.close()
                result = recorder.finish()
            self.assertEqual(result['status'], 'complete', result)
            self.assertEqual(result['communicationEvents'], 1)
            with recorder.csv_path.open(newline='') as handle:
                row = next(csv.DictReader(handle))
            self.assertEqual(json.loads(row['udp_receive'])['data'], '\0' * 65507)


if __name__ == '__main__':
    unittest.main()
