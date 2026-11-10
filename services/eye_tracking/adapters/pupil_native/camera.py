"""Strict camera identity, explicit intrinsics and OpenCV projection boundary."""
import json
import math
import re
import sys
import time
from pathlib import Path


def source_clock():
    # CPython 3.11/3.12 monotonic on Windows uses coarse GetTickCount64.
    # QPC is system-wide in supported Python versions; share this clock with
    # source_time() and binocular pairing, not per-process rebased offsets.
    return time.perf_counter() if sys.platform == 'win32' else time.monotonic()


def select_devices(devices, uids=()):
    selected = {}
    for role in (0, 1, 2):
        candidates = [d for d in devices if (d['uid'] == uids[role] if uids else
                      re.fullmatch(rf'Pupil Cam[123] ID{role}', d.get('name', '')))]
        if len(candidates) != 1:
            raise ValueError(f'Pupil 原生采集：ID{role} 相机数量为 {len(candidates)}，需要唯一的双眼及场景相机；检查 USB、驱动或设备 UID 配置')
        selected[role] = candidates[0]
    if len({d['uid'] for d in selected.values()}) != 3:
        raise ValueError('Pupil camera UIDs must be distinct')
    return selected


def intrinsics_for(name, resolution, overrides=None):
    defaults = json.loads((Path(__file__).parent / 'vendor/camera_intrinsics.json').read_text())
    custom = (overrides or {}).get(name, {}).get(str(tuple(resolution)))
    value = custom or defaults.get(name, {}).get(str(tuple(resolution)))
    if value is None:
        raise ValueError(f'缺少 {name} {tuple(resolution)} 的相机内参，请提供实测内参')
    return {**value, 'name': name, 'resolution': list(resolution),
            'provenance': 'user_calibration' if custom else 'pupil_labs_default',
            'individually_calibrated': bool(custom)}


class Intrinsics:
    def __init__(self, spec):
        import numpy as np
        self.spec = spec
        self.resolution = tuple(spec['resolution'])
        self.K = np.asarray(spec['camera_matrix'], dtype=float)
        self.D = np.asarray(spec['dist_coefs'], dtype=float).reshape(-1)
        self.kind = spec['cam_type']
        if (len(self.resolution) != 2 or any(type(n) is not int or not 0 < n <= 8192 for n in self.resolution)
                or self.K.shape != (3, 3) or not np.isfinite(self.K).all() or not np.isfinite(self.D).all()
                or min(self.K[0, 0], self.K[1, 1]) <= 0 or self.kind not in ('radial', 'fisheye')
                or self.D.size not in ((4,) if self.kind == 'fisheye' else (4, 5, 8, 12, 14))
                or not np.allclose(self.K[2], [0, 0, 1])):
            raise ValueError('Invalid camera intrinsics')

    @property
    def focal_length(self):
        return float((self.K[0, 0] + self.K[1, 1]) / 2)

    def unprojectPoints(self, points, normalize=False):
        import cv2
        import numpy as np
        points = np.asarray(points, dtype=float).reshape(-1, 1, 2)
        fn = cv2.fisheye.undistortPoints if self.kind == 'fisheye' else cv2.undistortPoints
        xy = fn(points, self.K, self.D).reshape(-1, 2)
        rays = np.column_stack((xy, np.ones(len(xy))))
        return rays / np.linalg.norm(rays, axis=1)[:, None] if normalize else rays

    def projectPoints(self, points, rvec=None, tvec=None):
        import cv2
        import numpy as np
        points = np.asarray(points, dtype=float).reshape(-1, 1, 3)
        fn = cv2.fisheye.projectPoints if self.kind == 'fisheye' else cv2.projectPoints
        return fn(points, np.zeros(3) if rvec is None else rvec,
                  np.zeros(3) if tvec is None else tvec, self.K, self.D)[0]


class FrameClock:
    """Map libuvc clock to host monotonic once, never rebase each frame."""
    def __init__(self, offset, *, software=False, latency=0):
        self.offset, self.software, self.latency = offset, software, latency
        self.previous = None

    def timestamp(self, source, received):
        value = received + self.latency if self.software else source + self.offset
        if (not math.isfinite(value) or not math.isfinite(received) or abs(value - received) > .5 or
                self.previous is not None and value <= self.previous):
            raise ValueError('Camera timestamp invalid, stale or regressed; reconnect required '
                             f'(software={self.software}, source={source!r}, received={received!r}, '
                             f'previous={self.previous!r}, mapped={value!r})')
        self.previous = value
        return value
