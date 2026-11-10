"""Offline analysis must work without starting the selected device service."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import cv2
import numpy as np


class MappingEntrypointTests(unittest.TestCase):
    root = Path(__file__).resolve().parents[3]

    def exercise_entrypoint(self, command, *, guard_runtime=False, job_flag='--gaze-map-job'):
        with tempfile.TemporaryDirectory(prefix='mrt-mapping-') as directory:
            folder = Path(directory)
            # Deterministic textured scene gives real SIFT features without any
            # camera or user recording. Every frame equals the target image.
            rng = np.random.default_rng(17)
            frame = rng.integers(0, 256, (240, 320, 3), dtype=np.uint8)
            image = folder / '参考图片.png'
            image.write_bytes(cv2.imencode('.png', frame)[1].tobytes())
            video = folder / 'scene.avi'
            writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*'MJPG'), 30, (320, 240))
            self.assertTrue(writer.isOpened())
            for _ in range(3):
                writer.write(frame)
            writer.release()
            output = folder / '映射结果.json'
            job = folder / '离线任务.json'
            job.write_text(json.dumps({'videoPath': str(video), 'imagePath': str(image), 'outputPath': str(output),
                'gazePoints': [{'x': .5, 'y': .5, 'timestamp': 0, 'id': 'center'}],
                'keyframeIntervalFrames': 1}), encoding='utf-8')
            env = {**os.environ, 'PYTHONUTF8': '1'}
            if guard_runtime:
                (folder / 'sitecustomize.py').write_text('''import sys
class NoAcquisition:
    def find_spec(self, fullname, path=None, target=None):
        if fullname in ('services.eye_tracking.application.pupil_runtime',
                        'services.eye_tracking.transport.pupil_runtime',
                        'services.eye_tracking.adapters.pupil_native.source',
                        'services.eye_tracking.application.huahong_runtime',
                        'services.eye_tracking.transport.huahong_runtime',
                        'services.eye_tracking.adapters.huahong.service',
                        'services.eye_tracking.adapters.huahong.vendor',
                        'application.sdk_service', 'transport.server_runtime',
                        'adapters.invensun_7',
                        'services.eye_tracking.application.sdk_service',
                        'services.eye_tracking.transport.server_runtime',
                        'services.eye_tracking.adapters.invensun_7'):
            raise RuntimeError('Mapping imported acquisition runtime: ' + fullname)
sys.meta_path.insert(0, NoAcquisition())
''', encoding='utf-8')
                env['PYTHONPATH'] = str(folder)
            result = subprocess.run([*command, job_flag, str(job)], cwd=self.root,
                                    env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            response = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertTrue(response['ok'])
            mapped = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(mapped['summary']['inputPoints'], 1)
            self.assertEqual(mapped['summary']['mappedPoints'], 1)
            self.assertAlmostEqual(mapped['gazeData'][0]['x'], 160, delta=1)
            self.assertAlmostEqual(mapped['gazeData'][0]['y'], 120, delta=1)
            self.assertNotIn('service listening', result.stderr)
            self.assertNotIn('pupil.backend revision=', result.stderr)

    def test_shared_module_maps_without_any_device_runtime(self):
        self.exercise_entrypoint([sys.executable, '-m', 'services.eye_tracking.analysis.gaze_mapper'],
                                 guard_runtime=True, job_flag='--job')

    def test_legacy_script_maps_without_importing_7invensun_sdk(self):
        self.exercise_entrypoint([sys.executable, str(self.root / 'services/eye_tracking/entrypoints/server.py')],
                                 guard_runtime=True)

    def test_pupil_module_maps_without_importing_acquisition_runtime(self):
        self.exercise_entrypoint([sys.executable, '-m', 'services.eye_tracking.entrypoints.pupil_server'], guard_runtime=True)

    def test_huahong_module_maps_without_importing_sdk_or_acquisition_runtime(self):
        self.exercise_entrypoint([sys.executable, '-m', 'services.eye_tracking.entrypoints.huahong_server'], guard_runtime=True)

    def test_pupil_module_returns_structured_mapping_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory) / 'missing.json'
            result = subprocess.run([sys.executable, '-m', 'services.eye_tracking.entrypoints.pupil_server', '--gaze-map-job', str(job)],
                                    cwd=self.root, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 1)
            error = json.loads(result.stderr.strip().splitlines()[-1])
            self.assertFalse(error['ok'])
            self.assertIn('missing.json', error['message'])
            self.assertNotIn('service listening', result.stderr)

    @unittest.skipUnless(os.environ.get('MRT_PUPIL_EXECUTABLE'), 'Set target-platform packaged executable')
    def test_packaged_pupil_maps_without_device_service(self):
        self.exercise_entrypoint([os.environ['MRT_PUPIL_EXECUTABLE']])

    @unittest.skipUnless(os.environ.get('MRT_HUAHONG_EXECUTABLE'), 'Set Windows Huahong packaged executable')
    def test_packaged_huahong_maps_without_device_service(self):
        self.exercise_entrypoint([os.environ['MRT_HUAHONG_EXECUTABLE']])

    @unittest.skipUnless(os.environ.get('MRT_INVENSUN_EXECUTABLE'), 'Set Windows 7invensun packaged executable')
    def test_packaged_invensun_maps_without_device_service(self):
        self.exercise_entrypoint([os.environ['MRT_INVENSUN_EXECUTABLE']])
