"""Native settings stay in the backend; no device UI fork."""
from dataclasses import dataclass
import json
from pathlib import Path


@dataclass(frozen=True)
class NativeConfig:
    camera_uids: tuple = ()
    intrinsics_path: str = ''
    eye_fps: int = 120
    world_fps: int = 30
    startup_timeout_s: float = 20

    def __post_init__(self):
        if self.camera_uids and (len(self.camera_uids) != 3 or any(not isinstance(v, str) or not v for v in self.camera_uids)):
            raise ValueError('Provide right-eye, left-eye, scene UIDs together')
        if any(type(v) is not int or not 1 <= v <= 200 for v in (self.eye_fps, self.world_fps)):
            raise ValueError('Invalid native camera rate')
        if not 1 <= self.startup_timeout_s <= 60:
            raise ValueError('Invalid native startup timeout')

    def intrinsics(self):
        if not self.intrinsics_path:
            return {}
        path = Path(self.intrinsics_path)
        if path.stat().st_size > 1024 * 1024:
            raise ValueError('Camera intrinsics file too large')
        result = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(result, dict):
            raise ValueError('Camera intrinsics must map camera names and resolutions')
        return result
