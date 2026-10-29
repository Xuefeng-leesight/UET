import csv
import ctypes as C
from dataclasses import asdict, replace
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from services.eye_tracking.adapters.huahong.data_normalizer import gaze_csv_row, gaze_message
from services.eye_tracking.adapters.huahong.et28_samples import et28_gaze_sample
from services.eye_tracking.adapters.huahong.vendor import et28_dll as b
from services.eye_tracking.domain.samples import GazeSample, SampleIdentity, VideoFrame
from services.eye_tracking.infrastructure.pupil_recorder import PupilRecorder


class ET28SampleTests(unittest.TestCase):
    def identity(self):
        return SampleIdentity('HH_ET28', 'gaze', 1, 2, 10.05, 10.05)

    def output(self):
        output = b.et28_GzTrackerPredictOutput()
        output.haveGazeInfoLeft = output.haveGazeInfoRight = True
        output.haveEyeInfoLeft, output.haveEyeInfoRight = False, True
        output.worldPointLeft = b.et28_GzTrackerPoint2d(400, 300)
        output.worldPointRight = b.et28_GzTrackerPoint2d(1200, 900)
        output.eyeInfoLeft.pupilCenter = b.et28_GzTrackerPoint2d(17, 23)
        output.eyeInfoLeft.pupilWidth, output.eyeInfoLeft.pupilHeight = 31, 19
        output.eyeInfoLeft.pupilAngle = 12
        output.sightLineLeft.corneaCenter = b.et28_GzTrackerVec3(1, 2, 3)
        output.sightLineLeft.direction = b.et28_GzTrackerVec3(4, 5, 6)
        return output

    def sample(self, output=None):
        return et28_gaze_sample(output or self.output(), self.identity(), (1600, 1200))

    def test_binocular_recommendation_retains_independent_flags_and_world_resolution(self):
        sample = self.sample()
        self.assertEqual(sample.position, (.5, .5))
        self.assertEqual(sample.contributing_eyes, ('left', 'right'))
        self.assertEqual(sample.monocular['left']['position'], (.25, .25))
        self.assertEqual(sample.monocular['right']['position'], (.75, .75))
        self.assertEqual(sample.world_resolution, (1600, 1200))
        self.assertEqual(sample.coordinate_space, 'world_normalized_top_left')
        self.assertFalse(sample.monocular['left']['vendor']['haveEyeInfo'])
        self.assertTrue(sample.monocular['left']['vendor']['haveGazeInfo'])
        self.assertTrue(sample.monocular['right']['vendor']['haveEyeInfo'])
        self.assertEqual(sample.pupils, ())
        self.assertIsNone(sample.point_3d)
        self.assertIsNone(sample.confidence)
        self.assertFalse(sample.native, 'vendor geometry must not enter Pupil world-camera-mm conversion')

    def test_single_eye_uses_gaze_flag_not_independent_eye_info_flag(self):
        output = self.output()
        output.haveGazeInfoRight = False
        sample = self.sample(output)
        self.assertTrue(sample.valid)
        self.assertEqual(sample.position, (.25, .25))
        self.assertEqual(sample.contributing_eyes, ('left',))
        self.assertIsNone(sample.monocular['right']['position'])
        raw = sample.monocular['right']['vendor']
        self.assertFalse(raw['haveGazeInfo'])
        self.assertTrue(raw['haveEyeInfo'])
        self.assertEqual(raw['worldPoint'], {'x': 1200, 'y': 900})
        row = gaze_csv_row(sample, 10)
        self.assertEqual(row['left_gaze_bit_mask'], 1)
        self.assertEqual(row['right_gaze_bit_mask'], 0)
        self.assertEqual(row['right_gaze_x'], '')
        data = json.loads(gaze_message(sample))['eye_data']
        self.assertEqual(data['l_gaze']['gaze'], {'x': .25, 'y': .25})
        self.assertIsNone(data['r_gaze']['gaze'])

    def test_raw_callback_copy_outlives_native_storage_and_nonfinite_values_are_json_null(self):
        output = self.output()
        output.worldPointLeft.x = float('nan')
        output.eyeInfoLeft.pupilWidth = float('inf')
        output.sightLineLeft.direction.z = float('-inf')
        sample = self.sample(output)
        C.memset(C.byref(output), 0, C.sizeof(output))
        raw = sample.monocular['left']['vendor']
        self.assertIsNone(raw['worldPoint']['x'])
        self.assertIsNone(raw['eyeInfo']['pupilWidth'])
        self.assertIsNone(raw['sightLine']['direction']['z'])
        self.assertEqual(raw['worldPoint']['y'], 300)
        self.assertEqual(raw['eyeInfo']['pupilCenter'], {'x': 17, 'y': 23})
        self.assertEqual(raw['eyeInfo']['pupilHeight'], 19)
        self.assertEqual(raw['eyeInfo']['pupilAngle'], 12)
        self.assertEqual(raw['sightLine']['corneaCenter'], {'x': 1, 'y': 2, 'z': 3})
        self.assertEqual(sample.position, (.75, .75))
        journal = json.loads(json.dumps(asdict(sample), allow_nan=False))
        self.assertIsNone(journal['monocular']['left']['vendor']['eyeInfo']['pupilWidth'])
        self.assertEqual(journal['monocular']['right']['vendor']['worldPoint']['x'], 1200)

    def test_range_rules_keep_real_corners_and_preserve_outside_raw_values(self):
        for point, expected in [((0, 0), (0, 0)), ((1600, 1200), (1, 1)),
                                ((-1, 20), None), ((1601, 20), None), ((20, 1201), None)]:
            with self.subTest(point=point):
                output = self.output()
                output.haveGazeInfoRight = False
                output.worldPointLeft = b.et28_GzTrackerPoint2d(*point)
                sample = self.sample(output)
                self.assertEqual(sample.position, expected)
                self.assertEqual(sample.valid, expected is not None)
                self.assertEqual(sample.monocular['left']['vendor']['worldPoint'], dict(zip(('x', 'y'), point)))
        for resolution in ((0, 1200), (1600, -1), (True, 1200), (1600.0, 1200)):
            with self.subTest(resolution=resolution), self.assertRaises(ValueError):
                et28_gaze_sample(self.output(), self.identity(), resolution)

    def test_missing_gaze_does_not_fabricate_points_or_pupil_validity(self):
        output = self.output()
        output.haveGazeInfoLeft = output.haveGazeInfoRight = False
        sample = self.sample(output)
        self.assertFalse(sample.valid)
        self.assertIsNone(sample.position)
        row = gaze_csv_row(sample, 10)
        self.assertEqual(row['recom_gaze_bit_mask'], 0)
        self.assertEqual(row['source_norm_pos_x'], '')
        self.assertEqual(row['source_norm_pos_y'], '')
        self.assertEqual(row['pupil_valid'], '')
        data = json.loads(gaze_message(sample))['eye_data']
        for prefix in ('re', 'l', 'r'):
            self.assertEqual(data[f'{prefix}_gaze']['gaze_bit_mask'], 0)
            self.assertIsNone(data[f'{prefix}_gaze']['gaze'])

    def test_csv_and_websocket_expose_real_monocular_coordinates_without_invented_units(self):
        output = self.output()
        output.worldPointLeft.y, output.worldPointRight.y = 900, 150
        sample = self.sample(output)
        row = gaze_csv_row(sample, 10)
        self.assertAlmostEqual(row['timestamp'], 50)
        self.assertEqual(row['source_backend'], 'huahong_sdk')
        self.assertEqual(row['source_model'], 'HH_ET28')
        self.assertEqual(row['recom_gaze_bit_mask'], 1)
        self.assertEqual((row['source_norm_pos_x'], row['source_norm_pos_y']), sample.position)
        self.assertEqual((row['left_gaze_x'], row['left_gaze_y']), (.25, .75))
        self.assertEqual((row['right_gaze_x'], row['right_gaze_y']), (.75, .125))
        for eye in ('left', 'right'):
            self.assertEqual(row[f'{eye}_gaze_bit_mask'], 1)
            for field in ('pupil_diameter', 'pupil_diameter_mm', 'pupil_diameter_px', 'pupil_center_x',
                          'pupil_minor_axis', 'pupil_distance', 'pupil_valid', 'origin_x', 'direction_x', 'gaze_point_z'):
                self.assertEqual(row[f'{eye}_{field}'], '', field)
        self.assertEqual(row['pupil_valid'], '')
        self.assertEqual(row['pupil_center_space'], '')
        data = json.loads(gaze_message(sample))['eye_data']
        self.assertIsNone(data['l_pupil']['center'], 'Eye-info validity is independent of gaze validity')
        self.assertEqual(data['l_gaze']['gaze'], {'x': .25, 'y': .75})
        self.assertEqual(data['r_gaze']['gaze'], {'x': .75, 'y': .125})
        # CSV export defines these columns as physical 3D points; the live UI
        # retains its explicitly 2D compatibility aliases in the WS envelope.
        for eye in ('recom', 'left', 'right'):
            for column in ('gaze_point', 'raw_point', 'smooth_point'):
                for axis in 'xyz':
                    self.assertEqual(row[f'{eye}_{column}_{axis}'], '')
        for eye, key in (('left', 'l_gaze'), ('right', 'r_gaze')):
            for field in ('gaze_point', 'raw', 'smooth'):
                self.assertEqual((row[f'{eye}_gaze_x'], row[f'{eye}_gaze_y']),
                                 tuple(data[key][field][axis] for axis in ('x', 'y')))

    def test_live_pupil_centers_use_independent_eye_flags_without_unit_conversion(self):
        output = self.output()
        output.haveEyeInfoLeft, output.haveEyeInfoRight = True, False
        output.haveGazeInfoLeft = False
        output.eyeInfoRight.pupilCenter = b.et28_GzTrackerPoint2d(211, 197)
        sample = self.sample(output)
        C.memset(C.byref(output), 0, C.sizeof(output))
        data = json.loads(gaze_message(sample))['eye_data']
        self.assertIsNone(data['l_gaze']['gaze'])
        self.assertEqual(data['r_gaze']['gaze'], {'x': .75, 'y': .75})
        self.assertEqual(data['l_pupil'], {'center': {'x': 17, 'y': 23},
                                         'center_space': 'vendor_et28_eye_info', 'center_unit': 'unverified'})
        self.assertIsNone(data['r_pupil']['center'])
        for key in ('l_pupil', 'r_pupil'):
            self.assertNotIn('dia', data[key])
            self.assertNotIn('dia_mm', data[key])
        row = gaze_csv_row(sample, 10)
        self.assertEqual(row['left_pupil_center_x'], '')
        self.assertEqual(row['left_pupil_diameter_mm'], '')
        self.assertEqual(row['pupil_center_space'], '', 'Unverified live coordinates must not enter normalized CSV fields')

    def test_missing_and_nonfinite_pupil_centers_are_null_but_real_zero_is_preserved(self):
        for center in ((float('nan'), 20), (20, float('inf')), (float('-inf'), 20), (0, 0)):
            with self.subTest(center=center):
                output = self.output()
                output.haveEyeInfoLeft = True
                output.eyeInfoLeft.pupilCenter = b.et28_GzTrackerPoint2d(*center)
                data = json.loads(gaze_message(self.sample(output)))['eye_data']
                self.assertEqual(data['l_pupil']['center'], {'x': 0, 'y': 0} if center == (0, 0) else None)
        sample = replace(self.sample(), monocular={})
        data = json.loads(gaze_message(sample))['eye_data']
        self.assertIsNone(data['l_pupil']['center'])
        self.assertIsNone(data['r_pupil']['center'])

    def test_actual_live_consumer_displays_and_clears_vendor_pupil_centers(self):
        root = Path(__file__).resolve().parents[3]
        if not shutil.which('node') or not (root / 'node_modules/typescript').is_dir():
            if os.environ.get('MRT_REQUIRE_MEDIA_TESTS') == '1':
                self.fail('Node and TypeScript required')
            self.skipTest('Node and TypeScript required')
        output = self.output()
        output.haveEyeInfoLeft = output.haveEyeInfoRight = True
        output.eyeInfoRight.pupilCenter = b.et28_GzTrackerPoint2d(211, 197)
        cases = []
        def add_case(left, right):
            cases.append({'message': json.loads(gaze_message(self.sample(output))),
                          'left': left, 'right': right})
        add_case([17, 23], [211, 197])
        output.haveGazeInfoLeft = False
        add_case([17, 23], [211, 197])
        output.haveEyeInfoLeft = False
        add_case(None, [211, 197])
        output.eyeInfoRight.pupilCenter.x = float('nan')
        add_case(None, None)
        output.haveEyeInfoLeft = True
        output.eyeInfoLeft.pupilCenter = b.et28_GzTrackerPoint2d(0, 0)
        add_case([0, 0], None)
        legacy = GazeSample(replace(self.identity(), source='HH_ET10C'), (.5, .25),
                            'screen_normalized_top_left', None, True, ('left',))
        cases.append({'message': json.loads(gaze_message(legacy)), 'left': None, 'right': None})
        result = subprocess.run(['node', str(Path(__file__).with_name('check_live_eye_data.mjs'))],
                                cwd=root, input=json.dumps(cases, allow_nan=False), text=True,
                                capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_et10_primary_coordinates_and_legacy_envelope_remain_compatible(self):
        for position in ((0, .75), (0, 0), None):
            with self.subTest(position=position):
                sample = GazeSample(replace(self.identity(), source='HH_ET10C'), position,
                                    'screen_normalized_top_left', None, position is not None, ('left',))
                row = gaze_csv_row(sample, 10)
                self.assertEqual((row['recom_gaze_x'], row['recom_gaze_y']), position or ('', ''))
                self.assertEqual((row['source_norm_pos_x'], row['source_norm_pos_y']), position or ('', ''))
                self.assertEqual(row['source_backend'], 'huahong_sdk')
                self.assertEqual(row['left_gaze_x'], '')
                self.assertEqual(row['recom_gaze_bit_mask'], 1 if position is not None else 0)
                for eye in ('recom', 'left', 'right'):
                    for column in ('gaze_point', 'raw_point', 'smooth_point'):
                        for axis in 'xyz':
                            self.assertEqual(row[f'{eye}_{column}_{axis}'], '')
                data = json.loads(gaze_message(sample))
                self.assertEqual(data['source'], 'HH_ET10C')
                self.assertEqual(set(data['eye_data']), {'ts', 're_gaze'})
                expected = dict(zip(('x', 'y'), position)) if position is not None else None
                self.assertEqual(data['eye_data']['re_gaze']['gaze'], expected)

    def test_actual_csv_parser_keeps_replay_for_all_display_paths_without_3d_aliases(self):
        root = Path(__file__).resolve().parents[3]
        if not shutil.which('node') or not (root / 'node_modules/typescript').is_dir():
            if os.environ.get('MRT_REQUIRE_MEDIA_TESTS') == '1':
                self.fail('Node and TypeScript required')
            self.skipTest('Node and TypeScript required')
        output = self.output()
        output.haveGazeInfoRight = False
        single_eye = self.sample(output)
        output.worldPointLeft = b.et28_GzTrackerPoint2d(0, 0)
        corner = self.sample(output)
        output.haveGazeInfoLeft = False
        missing = self.sample(output)
        cases = []
        for sample in (self.sample(), single_eye, corner, missing):
            cases.append({'row': gaze_csv_row(sample, 10), 'position': sample.position})
        for position in ((.25, .75), (0, 0), None):
            sample = GazeSample(replace(self.identity(), source='HH_ET10C'), position,
                                'screen_normalized_top_left', None, position is not None, ('left',))
            cases.append({'row': gaze_csv_row(sample, 10), 'position': position})
        result = subprocess.run(['node', str(Path(__file__).with_name('check_csv.mjs'))],
                                cwd=root, input=json.dumps(cases, allow_nan=False), text=True,
                                capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_real_recording_archives_callback_fields_and_monocular_csv(self):
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            if os.environ.get('MRT_REQUIRE_MEDIA_TESTS') == '1':
                self.fail('ffmpeg/ffprobe required')
            self.skipTest('ffmpeg/ffprobe required')
        identity = replace(self.identity(), topic='scene', source_time_s=10, received_monotonic_s=10)
        frame = VideoFrame(identity, 'scene', 16, 16, 'bgr', bytes(16 * 16 * 3), None)
        sample = self.sample()
        with tempfile.TemporaryDirectory() as directory:
            recorder = PupilRecorder(Path(directory), 'huahong_callback', frame, fps=10, source_model='HH_ET28',
                                     row_mapper=gaze_csv_row, source_info={'timestampSource': 'host_arrival'})
            recorder.start()
            recorder.submit([sample, replace(frame, identity=replace(identity, source_time_s=10.2))], ())
            result = recorder.finish()
            self.assertEqual(result['status'], 'complete', result)
            self.assertEqual(result['gazeRows'], 1)
            self.assertEqual(result['validityPercent'], 100)
            journal = [json.loads(line) for line in (recorder.sidecar / 'normalized-samples.jsonl').read_text().splitlines()]
            self.assertEqual(journal[0]['world_resolution'], [1600, 1200])
            self.assertEqual(journal[0]['monocular']['left']['vendor']['eyeInfo']['pupilAngle'], 12)
            self.assertEqual(journal[0]['monocular']['left']['vendor']['sightLine']['direction']['z'], 6)
            with recorder.csv_path.open() as file:
                row = next(csv.DictReader(file))
            self.assertEqual(row['source_backend'], 'huahong_sdk')
            self.assertEqual(float(row['left_gaze_x']), .25)
            self.assertEqual(float(row['right_gaze_y']), .75)
            self.assertEqual(row['pupil_valid'], '')
            self.assertEqual(row['recom_gaze_bit_mask'], '1')
            for eye in ('recom', 'left', 'right'):
                for column in ('gaze_point', 'raw_point', 'smooth_point'):
                    for axis in 'xyz':
                        self.assertEqual(row[f'{eye}_{column}_{axis}'], '')


if __name__ == '__main__':
    unittest.main()
