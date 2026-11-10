"""et10c_interface.dll 的定位、加载与符号绑定。

搜索顺序（先命中先用）：

1. 显式参数 ``dll_dir``
2. 环境变量 ``ET10C_DLL_DIR``
3. 包内 ``et10c_gaze/dll``
4. 项目根 ``python_gaze_sdk/dll``
5. ``<SDK 根>/ReleaseEt10cWinSdkV*/Windows/bin_win64``（取版本最高）

因为 ``et10c_interface.dll`` 静态依赖同目录的 opencv / ncnn / remoteTrackerPro 等 DLL，
加载前会把该目录加入 ``os.add_dll_directory`` 与 ``PATH``。
"""

from __future__ import annotations

import ctypes
import os
from pathlib import Path

from . import _ctypes_defs
from .errors import Et10cNotFoundError

__all__ = ["DLL_NAME", "DLL_DIR_ENV", "resolve_dll_dir", "load_sdk"]

DLL_NAME = "et10c_interface.dll"
DLL_DIR_ENV = "ET10C_DLL_DIR"

#: add_dll_directory 返回的句柄，必须全局持有，否则目录会被移除
_DIR_HANDLES: list[object] = []


def _sdk_root() -> Path | None:
    """推导 SDK 根目录（形如 ``D:\\x86\\ET10C``）。

    包路径为 ``<root>/Et10_interface_demo/python_gaze_sdk/et10c_gaze/``，
    也可以把本包单独拷到其它位置，此时返回 ``None``。
    """

    here = Path(__file__).resolve()
    for parent in here.parents:
        if parent.name.lower().startswith("releaseet10c"):
            return parent.parent
    # 常规布局：et10c_gaze -> python_gaze_sdk -> 工作目录 -> SDK 根
    if len(here.parents) > 3:
        return here.parents[3]
    return None


def _version_tag(path: Path) -> str:
    """取出路径中的 SDK 版本目录名（用于排序）。"""

    for part in path.parts:
        if part.lower().startswith("releaseet10c"):
            return part.lower()
    return path.name.lower()


def _iter_candidate_dirs():
    here = Path(__file__).resolve()
    yield here.parent / "dll"
    yield here.parent.parent / "dll"

    root = _sdk_root()
    if root is None:
        return
    patterns = (
        "ReleaseEt10cWinSdkV*/Windows/bin_win64",
        "Release/WinSdkV*/Windows/bin_win64",
        "ReleaseEt10cWinSdkV*",
    )
    for pattern in patterns:
        matches = list(root.glob(pattern))
        # 同系列中稳定版优先、flip（图像翻转）变体靠后；版本号越大越靠前
        stable = sorted(
            (p for p in matches if "flip" not in _version_tag(p)),
            key=_version_tag,
            reverse=True,
        )
        variants = sorted(
            (p for p in matches if "flip" in _version_tag(p)),
            key=_version_tag,
            reverse=True,
        )
        for path in stable + variants:
            yield path


def resolve_dll_dir(dll_dir: str | os.PathLike[str] | None = None) -> Path:
    """定位包含 ``et10c_interface.dll`` 的目录。"""

    candidates: list[Path] = []
    if dll_dir is not None:
        candidates.append(Path(dll_dir).expanduser())
    env_dir = os.environ.get(DLL_DIR_ENV)
    if env_dir:
        candidates.append(Path(env_dir).expanduser())
    candidates.extend(_iter_candidate_dirs())

    for candidate in candidates:
        try:
            directory = candidate.resolve()
        except OSError:  # pragma: no cover - 非法路径
            continue
        if (directory / DLL_NAME).is_file():
            return directory

    tried = "\n  ".join(str(c) for c in candidates) or "(none)"
    raise Et10cNotFoundError(
        f"cannot locate {DLL_NAME}.\n"
        f"Searched:\n  {tried}\n"
        f"Fix: 从 ET10cWin SDK 压缩包解出 Windows/bin_win64，"
        f"或用环境变量 {DLL_DIR_ENV} 指向该目录。"
    )


def _register_dll_directory(directory: Path) -> None:
    """把 DLL 目录登记到加载器的搜索路径（Windows 的 "./ 优先" 语义不算可靠）。"""

    text = str(directory)
    if hasattr(os, "add_dll_directory"):
        _DIR_HANDLES.append(os.add_dll_directory(text))
    current = os.environ.get("PATH", "")
    if text not in current.split(os.pathsep):
        os.environ["PATH"] = text + os.pathsep + current


def load_sdk(
    dll_dir: str | os.PathLike[str] | None = None,
    *,
    bind: bool = True,
):
    """加载 ``et10c_interface.dll`` 并绑定函数原型。

    :param dll_dir: 显式指定 DLL 目录，None 时自动搜索
    :param bind: 是否自动应用 :data:`et10c_gaze._ctypes_defs.PROTOTYPES`
    :returns: ``ctypes.WinDLL`` 实例
    :raises Et10cNotFoundError: 找不到 DLL
    :raises OSError: DLL 或其依赖加载失败
    """

    directory = resolve_dll_dir(dll_dir)
    _register_dll_directory(directory)

    lib = ctypes.WinDLL(str(directory / DLL_NAME))
    if bind:
        _ctypes_defs.bind(lib)
    return lib
