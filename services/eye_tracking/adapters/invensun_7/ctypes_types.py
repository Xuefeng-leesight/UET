"""Vendor type-file discovery and historical symbol aliases.

ABI structures/callbacks remain in each vendor SDK type file. Do not copy or
unify them here: the three SDKs have different calling signatures.
"""

from pathlib import Path


class SDKTypesMixin:
    def _find_types_file(self, types_dir: Path):
        for filename in self.types_filenames:
            p = types_dir / filename
            if p.exists():
                return p
        return None

    def _normalize_types_symbols(self, T):
        if not hasattr(T, "py_7i_point_2d_t") and hasattr(T, "py_7i_point2d_t"):
            T.py_7i_point_2d_t = T.py_7i_point2d_t
        if not hasattr(T, "py_7i_point_3d_t") and hasattr(T, "py_7i_point3_t"):
            T.py_7i_point_3d_t = T.py_7i_point3_t

        if not hasattr(T, "fn_7i_image_callback_t") and hasattr(T, "func_image_callback_t"):
            T.fn_7i_image_callback_t = T.func_image_callback_t
        if not hasattr(T, "fn_7i_gaze_callback_t") and hasattr(T, "func_gaze_callback_t"):
            T.fn_7i_gaze_callback_t = T.func_gaze_callback_t
        if not hasattr(T, "fn_7i_camera_state_callback_t") and hasattr(T, "func_camera_state_callback_t"):
            T.fn_7i_camera_state_callback_t = T.func_camera_state_callback_t
        if not hasattr(T, "fn_7i_point_process_callback_t") and hasattr(T, "func_point_process_callback_t"):
            T.fn_7i_point_process_callback_t = T.func_point_process_callback_t
        if not hasattr(T, "fn_7i_point_finish_callback_t") and hasattr(T, "func_point_finish_callback_t"):
            T.fn_7i_point_finish_callback_t = T.func_point_finish_callback_t
