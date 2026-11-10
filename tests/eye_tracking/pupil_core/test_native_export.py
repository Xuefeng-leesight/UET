"""Verify native field semantics through actual replay and export consumers."""
import asyncio
import csv
from dataclasses import asdict, replace
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.adapters.pupil_native.source import message
from services.eye_tracking.infrastructure.pupil_csv import CSV_FIELDS, gaze_csv_row
from services.eye_tracking.infrastructure.pupil_events import event_rows
from tests.eye_tracking.pupil_core.test_recording import gaze


def event(topic, stamp, **kwargs):
    return DataNormalizer().normalize(message(dict(topic=topic, timestamp=stamp, confidence=1., native_source=True, **kwargs)), 1, 1)


class NativeExportTests(unittest.TestCase):
    def test_amplitude_uses_flanking_fixations_and_blink_sessions_reject_gaps(self):
        samples = [event('fixations', 0, id=1, duration=100, norm_pos=[.2, .5], world_resolution=[1280, 720], direction=[0, 0, 1]),
                   event('saccades', .1, id=1, duration=20, norm_pos=[.6, .5], metrics={'saccade_endpoint_distance_px': 99}),
                   event('fixations', .12, id=2, duration=100, norm_pos=[.8, .5], world_resolution=[1280, 720], direction=[.6, 0, .8]),
                   event('blinks', .2, type='onset', eye_id=0, detector_session=1),
                   event('blinks', .4, type='offset', eye_id=0, detector_session=2)]
        rows, report = event_rows([json.dumps(asdict(e)) + '\n' for e in samples], 0, 1)
        saccade = next(r for r in rows if r['source_event_type'] == 'saccade')
        self.assertAlmostEqual(saccade['saccade_distance_px'], 768)
        self.assertAlmostEqual(saccade['saccade_distance_deg'], 36.86989764584401)
        self.assertEqual(saccade['saccade_endpoint_distance_px'], 99)
        self.assertEqual(report['blinkOnsets'], 0)
        self.assertEqual(report['blinkUnpairedPhases'], 2)

    def test_native_3d_does_not_replace_replay_2d_or_pupil_mm(self):
        sample = replace(gaze(), native=True, point_3d=(125., -50., 500.), world_resolution=(1280, 720))
        row = gaze_csv_row(sample, 10)
        row.update(left_pupil_diameter=40, left_pupil_diameter_mm='')
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'native.csv'
            with source.open('w', newline='') as stream:
                writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS)
                writer.writeheader()
                writer.writerow(row)
            result = subprocess.run(['node', str(Path(__file__).with_name('check_native_export.mjs')), str(source)],
                                    text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(os.environ.get('MRT_PUPIL_EXECUTABLE'), 'Set target-platform packaged executable')
    def test_packaged_native_status_missing_camera_and_shutdown(self):
        from websockets.asyncio.client import connect
        async def scenario():
            sockets = [socket.socket() for _ in range(3)]
            try:
                for sock in sockets:
                    sock.bind(('127.0.0.1', 0))
                ports = [sock.getsockname()[1] for sock in sockets]
            finally:
                for sock in sockets:
                    sock.close()
            process = subprocess.Popen([os.environ['MRT_PUPIL_EXECUTABLE'], '--image-port', str(ports[0]),
                                        '--eye-port', str(ports[1]), '--command-port', str(ports[2]), '--control-stdin',
                                        '--camera-uid', 'mrt-test-missing-right', '--camera-uid', 'mrt-test-missing-left',
                                        '--camera-uid', 'mrt-test-missing-world'], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 60
                while True:
                    try:
                        ws = await connect(f'ws://127.0.0.1:{ports[2]}', proxy=None)
                        break
                    except OSError:
                        if process.poll() is not None or time.monotonic() >= deadline:
                            raise
                        await asyncio.sleep(.05)
                async with ws:
                    async def request(command):
                        await ws.send(json.dumps(dict(type='req_cmd', id=command)))
                        while True:
                            result = json.loads(await asyncio.wait_for(ws.recv(), 25))
                            if result.get('id') == command:
                                return result
                    status = await request('get_device_status')
                    self.assertEqual(status['backend'], 'native')
                    self.assertFalse(status['acquisition_ready'])
                    deadline = time.monotonic() + 190
                    while not status['algorithm_ready']:
                        self.assertFalse(status['algorithm_error'], status)
                        self.assertLess(time.monotonic(), deadline, status)
                        await asyncio.sleep(.05)
                        status = await request('get_device_status')
                    result = await request('start')
                    self.assertEqual(result['error'], -1, result)
                    self.assertIn('相机数量为 0', result['msg'])
                    self.assertFalse((await request('get_device_status'))['calibration_verified'])
                _, stderr = await asyncio.to_thread(process.communicate, input=b'shutdown\n', timeout=10)
                self.assertEqual(process.returncode, 0, stderr.decode(errors='replace'))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)
        asyncio.run(scenario())
