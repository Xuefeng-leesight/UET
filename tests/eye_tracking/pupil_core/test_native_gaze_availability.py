"""Native point availability stays truthful across disk and live 2D envelopes."""
from dataclasses import replace
import json
from pathlib import Path
import subprocess
import unittest

from services.eye_tracking.infrastructure.pupil_csv import gaze_csv_row
from services.eye_tracking.transport.pupil_protocol import gaze_message
from .test_recording import gaze


class NativeGazeAvailabilityTests(unittest.TestCase):
    def sample(self):
        return replace(gaze(), native=True, point_3d=(125., -50., 500.))

    def test_native_valid_points_do_not_claim_independent_smoothing(self):
        sample = self.sample()
        row = gaze_csv_row(sample, 10)
        live = json.loads(gaze_message(sample))['eye_data']['re_gaze']
        self.assertEqual(row['recom_gaze_bit_mask'], 3)
        self.assertEqual(live['gaze_bit_mask'], 3)
        self.assertIsNone(live['smooth'])
        self.assertEqual(live['raw'], {'x': .25, 'y': .25})
        self.assertEqual(row['geometry_space'], 'world_camera_mm')
        self.assertEqual([row[f'recom_raw_point_{axis}'] for axis in 'xyz'], [125., -50., 500.])
        self.assertEqual([row[f'recom_smooth_point_{axis}'] for axis in 'xyz'], ['', '', ''])

    def test_missing_3d_keeps_2d_recommendation_without_claiming_disk_raw(self):
        sample = replace(self.sample(), point_3d=None)
        row = gaze_csv_row(sample, 10)
        self.assertEqual(row['recom_gaze_bit_mask'], 1)
        self.assertEqual((row['recom_gaze_x'], row['recom_gaze_y']), (.25, .25))
        self.assertEqual([row[f'recom_raw_point_{axis}'] for axis in 'xyz'], ['', '', ''])
        live = json.loads(gaze_message(sample))['eye_data']['re_gaze']
        # Live raw is explicitly normalized 2D; it does not claim a 3D point.
        self.assertEqual(live['gaze_bit_mask'], 3)
        self.assertEqual(live['raw'], {'x': .25, 'y': .25})
        self.assertIsNone(live['smooth'])

    def test_invalid_native_sample_never_advertises_any_point(self):
        sample = replace(self.sample(), valid=False)
        row = gaze_csv_row(sample, 10)
        live = json.loads(gaze_message(sample))['eye_data']['re_gaze']
        self.assertEqual(row['recom_gaze_bit_mask'], 0)
        self.assertEqual(live['gaze_bit_mask'], 0)
        for kind in ('gaze_point', 'raw_point', 'smooth_point'):
            self.assertEqual([row[f'recom_{kind}_{axis}'] for axis in 'xyz'], ['', '', ''])
        for key in ('gaze', 'gaze_point', 'raw', 'smooth'):
            self.assertIsNone(live[key])

    def test_capture_preserves_real_3d_without_claiming_independent_smoothing(self):
        for valid in (True, False):
            sample = replace(self.sample(), native=False, valid=valid)
            row = gaze_csv_row(sample, 10)
            live = json.loads(gaze_message(sample))['eye_data']['re_gaze']
            self.assertEqual(row['recom_gaze_bit_mask'], 3 if valid else 0)
            self.assertEqual(live['gaze_bit_mask'], 3 if valid else 0)
            self.assertIsNone(live['smooth'])
            self.assertEqual(live['raw'], {'x': .25, 'y': .25} if valid else None)
            self.assertEqual(live['gaze'], live['raw'])
            self.assertEqual([row[f'recom_raw_point_{axis}'] for axis in 'xyz'],
                             [125., -50., 500.] if valid else ['', '', ''])
            self.assertEqual([row[f'recom_smooth_point_{axis}'] for axis in 'xyz'], ['', '', ''])

    def test_default_smooth_display_falls_back_using_real_selector(self):
        root = Path(__file__).resolve().parents[3]
        script = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const load = (file, dependencies = {}) => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), name);
    return dependencies[name];
  }});
  return exports;
};
const mapping = load('src/features/recording/domain/gazeMapping.ts');
const display = load('src/features/recording/domain/gazeDisplayPath.ts', {
  react: {}, '@/features/recording/domain/gazeMapping': mapping,
});
for (const packet of JSON.parse(fs.readFileSync(0, 'utf8'))) {
  const source = packet.eye_data.re_gaze;
  const data = {
    sourceModel: packet.source, recomGazeBitMask: source.gaze_bit_mask,
    recomGazeX: source.gaze?.x, recomGazeY: source.gaze?.y,
    recomPointX: source.gaze_point?.x, recomPointY: source.gaze_point?.y,
    recomRawX: source.raw?.x, recomRawY: source.raw?.y,
    recomSmoothX: source.smooth?.x, recomSmoothY: source.smooth?.y,
  };
  for (const isGlassesMode of [true, false]) {
    const point = display.selectGazeDisplayPoint(data, display.DEFAULT_GAZE_DISPLAY_PATH, { isGlassesMode });
    assert.equal(JSON.stringify(point), JSON.stringify(source.gaze));
  }
}
"""
        samples = [self.sample(), replace(self.sample(), point_3d=None),
                   replace(self.sample(), valid=False), replace(self.sample(), position=(0., 1.)),
                   replace(self.sample(), native=False),
                   replace(self.sample(), native=False, point_3d=None),
                   replace(self.sample(), native=False, valid=False)]
        result = subprocess.run(['node', '-e', script], cwd=root,
                                input=json.dumps([json.loads(gaze_message(sample)) for sample in samples]),
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
