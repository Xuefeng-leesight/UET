import os
from pathlib import Path
import shutil
import subprocess
import unittest


class ProductContracts(unittest.TestCase):
    def test_pupil_audio_contracts_and_real_mux(self):
        root = Path(__file__).resolve().parents[3]
        if not shutil.which("node") or not shutil.which("ffmpeg") or not (root / "node_modules/typescript").is_dir():
            if os.environ.get("MRT_REQUIRE_MEDIA_TESTS") == "1":
                self.fail("Node, TypeScript and FFmpeg required")
            self.skipTest("Audio contract tools unavailable")
        result = subprocess.run(["node", str(Path(__file__).with_name("check_audio.mjs"))],
                                cwd=root, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_typescript_product_contracts(self):
        root = Path(__file__).resolve().parents[3]
        if not shutil.which("node") or not (root / "node_modules/typescript").is_dir():
            if os.environ.get("MRT_REQUIRE_CONSUMER_TESTS") == "1":
                self.fail("Node/TypeScript required")
            self.skipTest("Node/TypeScript unavailable")
        result = subprocess.run(["node", str(Path(__file__).with_name("check_product_contracts.mjs"))],
                                cwd=root, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
