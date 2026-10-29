"""The classified service layout retains usable packages and dependency files."""
import importlib
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / 'services' / 'eye_tracking'


class ServiceLayoutTests(unittest.TestCase):
    def test_service_root_contains_only_package_marker(self):
        self.assertEqual(sorted(p.name for p in SERVICE.iterdir() if p.is_file()), ['__init__.py'])
        for name in ('server.py', 'pupil_server.py', 'huahong_server.py'):
            self.assertTrue((SERVICE / 'entrypoints' / name).is_file(), name)

    def test_offline_analysis_imports_from_package(self):
        mapper = importlib.import_module('services.eye_tracking.analysis.gaze_mapper')
        events = importlib.import_module('services.eye_tracking.analysis.eye_event_postprocess')
        self.assertTrue(callable(mapper.run_mapping))
        self.assertTrue(callable(events.postprocess_eye_event_csv))

    def test_all_dependency_includes_resolve_after_relocation(self):
        visited = set()

        def visit(filename, ancestors=()):
            filename = filename.resolve()
            self.assertTrue(filename.is_relative_to(ROOT), filename)
            self.assertNotIn(filename, ancestors, 'cyclic requirements include')
            self.assertTrue(filename.is_file(), filename)
            if filename in visited:
                return
            visited.add(filename)
            for raw in filename.read_text(encoding='utf-8').splitlines():
                line = raw.strip()
                if line.startswith('-r '):
                    visit(filename.parent / line[3:].strip(), (*ancestors, filename))

        for name in ('pupil-native.txt', 'pupil-capture.txt', 'pupil-build.txt'):
            visit(SERVICE / 'requirements' / name)
        visit(SERVICE / 'adapters/pupil_core/requirements-session.txt')
        self.assertIn(SERVICE / 'adapters/pupil_core/requirements.txt', visited)
