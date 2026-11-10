"""Bounded, aggregate diagnostics for pairing pupil data with card references."""

import math
from collections import Counter


def model_rejection(data):
    """Capture's model confidence is separate from ellipse detection confidence."""
    value = data.get("model_confidence")
    if type(value) not in (float, int) or not math.isfinite(value) or value != 1:
        return "model_not_ready" if value is None else "model_out_of_bounds"
    center = data.get("sphere", {}).get("center") if isinstance(data.get("sphere"), dict) else None
    if (not isinstance(center, (list, tuple)) or len(center) != 3 or
            any(type(v) not in (float, int) or not math.isfinite(v) for v in center)):
        return "model_not_ready"
    diameter = data.get("diameter_3d")
    if (abs(center[0]) > 10 or abs(center[1]) > 10 or not 20 <= center[2] <= 75 or
            type(diameter) not in (float, int) or not math.isfinite(diameter) or not 1 <= diameter <= 9):
        return "model_out_of_bounds"
    return None


def pupil_rejection(data, topic):
    eye = data.get("id")
    if type(eye) is not int or eye not in (0, 1):
        return "invalid_eye"
    if topic != f"pupil.{eye}.3d":
        return "not_3d"
    confidence = data.get("confidence")
    if type(confidence) not in (int, float) or not math.isfinite(confidence) or not .6 <= confidence <= 1:
        return "low_confidence"
    if not isinstance(data.get("circle_3d"), dict) or not isinstance(data.get("sphere"), dict):
        return "missing_3d_model"
    return model_rejection(data)


class PupilDiagnostics:
    def __init__(self):
        self.topics = Counter()
        self.rejected = Counter()
        self.rejected_by_eye = [Counter(), Counter()]
        self.eyes = [0, 0]
        self.offset_range = None
        self.confidence_range = None
        self.model_rejected_by_eye = [0, 0]
        self.source_times_by_eye = [[], []]

    def observe(self, message, source_start):
        data = message.payload
        # Bound topic cardinality even with custom detector identifiers.
        topic = message.topic if message.topic in (
            "pupil.0.2d", "pupil.1.2d", "pupil.0.3d", "pupil.1.3d") else "pupil.other"
        self.topics[topic] += 1
        timestamp = data.get("timestamp")
        if type(timestamp) not in (int, float) or not math.isfinite(timestamp):
            self.rejected["invalid_timestamp"] += 1
            return False
        offset = timestamp - source_start
        eye = data.get("id")
        if type(eye) is int and eye in (0, 1) and topic == f"pupil.{eye}.3d" and len(self.source_times_by_eye[eye]) < 2000:
            self.source_times_by_eye[eye].append(timestamp)
        self.offset_range = self._range(self.offset_range, offset)
        confidence = data.get("confidence")
        if type(confidence) in (int, float) and math.isfinite(confidence):
            self.confidence_range = self._range(self.confidence_range, confidence)
        rejection = pupil_rejection(data, message.topic)
        if offset <= 0:
            rejection = "before_reference_window"
        if rejection:
            self.rejected[rejection] += 1
            if type(eye) is int and eye in (0, 1) and topic == f"pupil.{eye}.3d":
                self.rejected_by_eye[eye][rejection] += 1
            if rejection in ("model_not_ready", "model_out_of_bounds") and type(data.get("id")) is int and data["id"] in (0, 1):
                self.model_rejected_by_eye[data["id"]] += 1
            return False
        self.eyes[data["id"]] += 1
        return True

    @staticmethod
    def _range(bounds, value):
        return [value, value] if bounds is None else [min(bounds[0], value), max(bounds[1], value)]

    def window_counts(self, window):
        if window is None:
            return [0, 0]
        return [sum(window[0] - .05 <= stamp <= window[1] + .05 for stamp in stamps)
                for stamps in self.source_times_by_eye]

    def report(self, paired_eyes):
        return {"topics": dict(self.topics), "rejected": dict(self.rejected),
                "rejected_by_eye": [dict(counts) for counts in self.rejected_by_eye],
                "eligible_by_eye": list(self.eyes), "paired_by_eye": paired_eyes,
                "model_rejected_by_eye": list(self.model_rejected_by_eye),
                "source_offset_s": self.offset_range, "confidence_range": self.confidence_range}

    def failure_message(self, paired_eyes):
        missing = "、".join("右眼" if eye == 0 else "左眼" for eye in (0, 1) if paired_eyes[eye] < 10)
        # A model failure in the other eye must not hide the affected eye's dominant detection failure.
        affected = sum((self.rejected_by_eye[eye] for eye in (0, 1) if paired_eyes[eye] < 10), Counter())
        model_count = affected["model_not_ready"] + affected["model_out_of_bounds"]
        if not self.topics:
            detail = "未收到瞳孔数据（眼图不等于瞳孔检测结果），请检查双眼摄像头与检测状态"
        elif not any(self.topics[f"pupil.{eye}.3d"] for eye in (0, 1)):
            detail = "仅收到 2D/其他检测数据，3D 瞳孔检测未输出"
        elif self.rejected["before_reference_window"] and not sum(self.eyes):
            detail = "瞳孔时间落后于场景参考帧，请等待实时数据同步后重试"
        elif model_count and model_count >= affected["low_confidence"]:
            detail = "3D 眼球模型未就绪或超出合理范围，请调整佩戴及眼部摄像头，注视不同方向建立模型后重试；检测置信度高不代表模型合格"
        elif self.rejected["low_confidence"]:
            detail = "瞳孔检测置信度不足，请调整眼部摄像头并保持睁眼"
        elif self.rejected["missing_3d_model"]:
            detail = "3D 眼球模型未就绪，请注视不同方向后重试"
        elif sum(self.eyes) and not sum(paired_eyes):
            detail = "瞳孔与场景参考帧时间不匹配，请等待实时数据同步后重试"
        else:
            detail = "有效 3D 瞳孔样本不足，请检查双眼检测并保持稳定"
        return f"{missing}采样不足：{detail}（右眼 {paired_eyes[0]} / 左眼 {paired_eyes[1]}，每眼至少 10）"
