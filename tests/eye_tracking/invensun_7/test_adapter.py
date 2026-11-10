import importlib
import ast
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import shutil
import subprocess
from unittest.mock import patch

from services.eye_tracking.adapters.invensun_7.data_normalizer import pick_gaze_xy
from services.eye_tracking.adapters.invensun_7.driver import (
    A8Driver,
    ASeeGlassesPlusDriver,
    ProDriver,
    create_sdk_driver,
)
from services.eye_tracking.adapters.invensun_7.paths import SDKPathsMixin, _vendor_path_bytes
from services.eye_tracking.adapters.invensun_7.ctypes_types import SDKTypesMixin


def point(x, y):
    return SimpleNamespace(x=x, y=y)


def gaze(mask=1, gaze_point=(0.2, 0.3), raw=(0.4, 0.5), smooth=(0.6, 0.7)):
    return SimpleNamespace(gaze_bit_mask=mask, gaze_point=point(*gaze_point),
                           raw_point=point(*raw), smooth_point=point(*smooth))


class InvensunAdapterTests(unittest.TestCase):
    def test_vendor_layout_resolves_all_models_and_container_overrides(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {}, clear=True):
            root = Path(temp).resolve()
            for model in ("Pro", "A8", "aSeeGlassesPlus"):
                driver = create_sdk_driver(model, root / "services" / "eye_tracking" / "entrypoints" / "server.py", lambda *args: None)
                vendor = root / "SDK" / "invensun_7" / model
                runtime = vendor / driver.runtime_suffix
                types = vendor / driver.types_suffix
                runtime.mkdir(parents=True)
                types.mkdir(parents=True)
                (runtime / "aSeeX.dll").write_bytes(b"fixture")
                config = driver._resolve_config_ini(runtime)
                config.parent.mkdir(parents=True, exist_ok=True)
                config.write_text("[softdog]\npwd=fixture\n")
                (types / ("sdk_types.py" if model == "aSeeGlassesPlus" else "_7i_types.py")).write_text("# fixture")
                for container in (None, root / "SDK", root / "SDK" / "invensun_7"):
                    with self.subTest(model=model, container=container):
                        os.environ.pop("MRT_SDK_CONTAINER", None)
                        if container:
                            os.environ["MRT_SDK_CONTAINER"] = str(container)
                        candidate = create_sdk_driver(model, root / "services" / "eye_tracking" / "entrypoints" / "server.py", lambda *args: None)
                        candidate.find_paths()
                        self.assertEqual(candidate.sdk_root, runtime)
                        self.assertEqual(candidate.types_dir, types)
                        self.assertEqual(candidate.config_ini, config)

    def test_electron_vendor_paths_and_packaged_resource_layout(self):
        if not shutil.which("node") or not Path("node_modules/typescript").is_dir():
            self.skipTest("Node/TypeScript unavailable")
        result = subprocess.run(["node", str(Path(__file__).with_name("check_sdk_paths.mjs"))],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_flat_layout_is_not_automatically_selected(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {}, clear=True):
            root = Path(temp)
            runtime = root / "SDK/Pro/bin/windows/x64/Pro200_Release"
            runtime.mkdir(parents=True)
            (runtime / "aSeeX.dll").write_bytes(b"fixture")
            (runtime / "config.ini").write_text("[softdog]\npwd=fixture")
            driver = ProDriver(root / "launcher.py", lambda *args: None)
            driver.find_paths()
            self.assertIsNone(driver.sdk_root)
            # Explicit deployment overrides remain usable and are never inferred.
            os.environ["MRT_SDK_ROOT"] = str(runtime)
            driver.find_paths()
            self.assertEqual(driver.sdk_root, runtime)

    def test_migration_keeps_legacy_driver_surface(self):
        baseline = json.loads(Path(__file__).with_name("migration_baseline.json").read_text())
        sources = [
            Path("services/eye_tracking/adapters/invensun_7/driver.py"),
            Path("services/eye_tracking/adapters/invensun_7/paths.py"),
            Path("services/eye_tracking/adapters/invensun_7/ctypes_types.py"),
        ]
        module_functions = set()
        class_methods = {}
        class_names = set()
        for source_path in sources:
            tree = ast.parse(source_path.read_text(encoding="utf-8"))
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    module_functions.add(node.name)
                if isinstance(node, ast.ClassDef):
                    class_names.add(node.name)
                    class_methods.setdefault(node.name, set()).update(
                        child.name for child in node.body
                        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                    )
        self.assertEqual(
            {key.split(".", 1)[0] for key in baseline["methods"] if "." not in key},
            module_functions,
        )
        for key in baseline["methods"]:
            if "." not in key:
                continue
            class_name, method_name = key.split(".", 1)
            # BaseSDKDriver's path/type methods intentionally live in mixins;
            # every other class remains physically in driver.py.
            if class_name == "BaseSDKDriver":
                available = set().union(*class_methods.values())
            else:
                available = class_methods.get(class_name, set())
            self.assertIn(f"{class_name}.{method_name}", {f"{class_name}.{name}" for name in available})

    def test_factory_preserves_all_three_model_aliases_without_loading_sdk(self):
        log = lambda *args: None
        self.assertIsInstance(create_sdk_driver("Pro", Path("."), log), ProDriver)
        self.assertIsInstance(create_sdk_driver("A8", Path("."), log), A8Driver)
        for alias in ("aSeeGlassesPlus", "asee_glasses_plus", "glassesplus"):
            driver = create_sdk_driver(alias, Path("."), log)
            self.assertIsInstance(driver, ASeeGlassesPlusDriver)
            self.assertIsNone(driver.sdk)

    def test_sdk_alias_and_package_imports_resolve_same_implementation(self):
        legacy = importlib.import_module("services.eye_tracking.adapters.invensun_7.sdk_driver")
        package = importlib.import_module("services.eye_tracking.adapters.invensun_7.driver")
        self.assertIs(legacy.create_sdk_driver, package.create_sdk_driver)
        self.assertIs(legacy.ProDriver, package.ProDriver)

    def test_gaze_selection_keeps_existing_priority_and_zero_behavior(self):
        self.assertEqual(pick_gaze_xy(gaze(mask=1), False), ((0.2, 0.3), "gaze", 1))
        self.assertEqual(pick_gaze_xy(gaze(mask=4), False), ((0.6, 0.7), "smooth", 4))
        self.assertEqual(pick_gaze_xy(gaze(mask=1, gaze_point=(0.0, 0.0)), False), ((0.0, 0.0), "gaze", 1))
        self.assertEqual(pick_gaze_xy(gaze(mask=0), False), ((0.2, 0.3), "gaze", 0))

    def test_gaze_selection_rejects_non_finite_values(self):
        result = pick_gaze_xy(gaze(gaze_point=(float("nan"), 0.3), raw=(float("inf"), 0.5)), False)
        self.assertEqual(result, ((0.6, 0.7), "smooth", 1))

    def test_path_helpers_do_not_require_vendor_dll(self):
        encoding = "mbcs" if os.name == "nt" else "utf-8"
        self.assertEqual(_vendor_path_bytes("abc/配置"), "abc/配置".encode(encoding, errors="replace"))
        self.assertTrue(issubclass(SDKPathsMixin, object))
        self.assertTrue(issubclass(SDKTypesMixin, object))

    def test_path_resolution_uses_script_anchor_and_model_specific_suffix(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sdk = root / "SDK" / "invensun_7" / "Pro" / "bin" / "windows" / "x64" / "Pro200_Release"
            sdk.mkdir(parents=True)
            (sdk / "aSeeX.dll").write_bytes(b"dll")
            (sdk / "config.ini").write_text("pwd=x")
            driver = ProDriver(root / "launcher.py", lambda *args: None)
            driver.find_paths()
            self.assertEqual(driver.sdk_root, sdk.resolve())
            self.assertEqual(driver.config_ini, (sdk / "config.ini").resolve())


if __name__ == "__main__":
    unittest.main()
