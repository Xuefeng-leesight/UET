"""Track a clicked scene feature in source pixels; no screen marker or Capture UI."""

from .frame_receiver import decode_frame


class NaturalFeatureTracker:
    def __init__(self, message, x, y):
        try:
            import cv2
            import numpy as np
        except ImportError as exc:
            raise ValueError('请更新 Pupil 独立环境：native 安装 services/eye_tracking/requirements/pupil-native.txt；Capture 安装 services/eye_tracking/requirements/pupil-capture.txt') from exc
        self.cv, self.np = cv2, np
        frame = decode_frame(message, 0, 0)
        self.size = (frame.width, frame.height)
        scale = min(1, 640 / max(self.size))
        self.tracking_size = (max(1, round(frame.width * scale)), max(1, round(frame.height * scale)))
        self.gray = self._gray(frame)
        self.point = np.array([[[min(x * self.tracking_size[0], self.tracking_size[0] - 1),
                                 min(y * self.tracking_size[1], self.tracking_size[1] - 1)]]], dtype=np.float32)
        px, py = self.point[0, 0]
        radius = min(50, max(8, min(self.tracking_size) // 4))
        patch = self.gray[max(0, int(py) - radius):int(py) + radius + 1,
                          max(0, int(px) - radius):int(px) + radius + 1]
        if min(self.size) < 16 or patch.size < 64 or float(patch.std()) < 3:
            raise ValueError('目标区域没有可追踪特征，请点击清晰的实体卡片中心')
        self.timestamp = message.payload['timestamp']

    def _gray(self, frame):
        bgr = self.np.frombuffer(frame.pixels, dtype=self.np.uint8).reshape(frame.height, frame.width, 3)
        if self.tracking_size != self.size:
            bgr = self.cv.resize(bgr, self.tracking_size, interpolation=self.cv.INTER_AREA)
        return self.cv.cvtColor(bgr, self.cv.COLOR_BGR2GRAY)

    def update(self, message):
        frame = decode_frame(message, 0, 0)
        timestamp = message.payload['timestamp']
        if self.size != (frame.width, frame.height) or not 0 < timestamp - self.timestamp <= .25:
            return None
        gray = self._gray(frame)
        options = {'winSize': (101, 101), 'maxLevel': 3}
        point, status, error = self.cv.calcOpticalFlowPyrLK(self.gray, gray, self.point, None, **options)
        if point is None or not status[0, 0] or not self.np.isfinite(point).all() or error[0, 0] > 20:
            return None
        back, status_back, _ = self.cv.calcOpticalFlowPyrLK(gray, self.gray, point, None, **options)
        if back is None or not status_back[0, 0] or float(self.np.linalg.norm(back - self.point)) > 1.5:
            return None
        width, height = self.tracking_size
        x, y = (float(v) for v in point[0, 0])
        delta = (point - self.point)[0, 0] / self.np.array([width, height])
        if not (0 <= x < width and 0 <= y < height) or float(self.np.linalg.norm(delta)) > .12:
            return None
        self.gray, self.point, self.timestamp = gray, point, timestamp
        return x * self.size[0] / width, y * self.size[1] / height
