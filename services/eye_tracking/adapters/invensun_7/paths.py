"""SDK/invensun_7 discovery and vendor path encoding.

Discovery is anchored to the caller-supplied script_path, not this module.
"""

import ctypes
import os
from pathlib import Path


def _windows_short_path(path):
    text = str(path)
    if os.name != "nt":
        return text
    try:
        get_short_path = ctypes.windll.kernel32.GetShortPathNameW
        get_short_path.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        get_short_path.restype = ctypes.c_uint
        buf = ctypes.create_unicode_buffer(32768)
        ret = get_short_path(text, buf, len(buf))
        if 0 < ret < len(buf):
            return buf.value
    except Exception:
        pass
    return text


def _vendor_path_bytes(path):
    text = _windows_short_path(path)
    if os.name == "nt":
        try:
            return text.encode("mbcs")
        except Exception:
            return text.encode("utf-8", errors="replace")
    return text.encode("utf-8")


class SDKPathsMixin:
    def _runtime_relatives(self):
        model = self.model_name
        return [
            Path("SDK") / "invensun_7" / model / self.runtime_suffix,
            Path("invensun_7") / model / self.runtime_suffix,
        ]

    def _types_relatives(self):
        model = self.model_name
        return [
            Path("SDK") / "invensun_7" / model / self.types_suffix,
            Path("invensun_7") / model / self.types_suffix,
        ]

    def _container_runtime_candidates(self):
        sdk_container = os.getenv("MRT_SDK_CONTAINER", "").strip()
        if not sdk_container:
            return []
        root = Path(sdk_container)
        if root.name != "invensun_7":
            root = root / "invensun_7"
        model = self.model_name
        return [
            (root / model / self.runtime_suffix).resolve(),
        ]

    def _container_types_candidates(self):
        sdk_container = os.getenv("MRT_SDK_CONTAINER", "").strip()
        if not sdk_container:
            return []
        root = Path(sdk_container)
        if root.name != "invensun_7":
            root = root / "invensun_7"
        model = self.model_name
        return [
            (root / model / self.types_suffix).resolve(),
        ]

    def _resolve_config_ini(self, root: Path) -> Path:
        return root / "config.ini"

    def _resolve_config_dir(self, root: Path) -> Path:
        return root / "config"

    def _is_runtime_valid(self, root: Path) -> bool:
        if not root:
            return False
        return (root / "aSeeX.dll").exists() and self._resolve_config_ini(root).exists()

    def find_paths(self):
        here = self.script_path

        env_sdk_root = os.getenv("MRT_SDK_ROOT", "").strip()
        if env_sdk_root:
            c = Path(env_sdk_root)
            if self._is_runtime_valid(c):
                self.sdk_root = c
                self.config_dir = self._resolve_config_dir(c)
                self.config_ini = self._resolve_config_ini(c)
                self.log("found sdk_root from env", str(self.sdk_root))

        runtime_candidates = self._container_runtime_candidates()
        for p in [here.parent, *here.parents]:
            for rel in self._runtime_relatives():
                runtime_candidates.append((p / rel).resolve())
        self.log(
            "scan sdk_root candidates",
            len(runtime_candidates),
            "model",
            self.model_name,
            "container",
            os.getenv("MRT_SDK_CONTAINER", "").strip() or None,
        )

        if self.sdk_root is None:
            for c in runtime_candidates:
                if self._is_runtime_valid(c):
                    self.sdk_root = c
                    self.config_dir = self._resolve_config_dir(c)
                    self.config_ini = self._resolve_config_ini(c)
                    self.log("found sdk_root", str(self.sdk_root))
                    break

        env_types_dir = os.getenv("MRT_TYPES_DIR", "").strip()
        if env_types_dir:
            t = Path(env_types_dir)
            if self._find_types_file(t):
                self.types_dir = t
                self.log("found types_dir from env", str(self.types_dir))

        type_candidates = self._container_types_candidates()
        for p in [here.parent, *here.parents]:
            for rel in self._types_relatives():
                type_candidates.append((p / rel).resolve())

        if self.types_dir is None:
            for t in type_candidates:
                if self._find_types_file(t):
                    self.types_dir = t
                    self.log("found types_dir", str(self.types_dir))
                    break
