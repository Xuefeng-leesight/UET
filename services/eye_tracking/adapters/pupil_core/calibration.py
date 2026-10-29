"""Tracked physical-card centers supply references to the selected 3D backend.

Only a matching setup.v2 plus fresh successful/result.v2 authorizes tracking.
All state belongs to this connection and is discarded on cancel or failure.
"""

import math
import logging
import time
import uuid
from itertools import combinations

from ...domain.contracts import UnsupportedCapability
from .natural_feature import NaturalFeatureTracker
from .feature_worker import FeatureWorker
from .pupil_quality import PupilDiagnostics
from .angular_metrics import SCORING_POLICY, score_label


class PupilCalibration:
    def __init__(self, network=None, *, resume_timeout_s=3, tracker_factory=NaturalFeatureTracker, worker_factory=FeatureWorker):
        self.worker_factory = worker_factory
        self.worker = None
        self.tracker_factory = tracker_factory
        self.network = network
        self.resume_timeout_s = resume_timeout_s
        self.reset()

    def reset(self):
        self._close_worker()
        if hasattr(self.network, 'cancel_fit'):
            self.network.cancel_fit()
        self.token = ""
        self.pending = False
        self.started = False
        self.source_start = 0.0
        self.deadline = 0.0
        self.success = None
        self.result = None
        self.finishing = False
        self.card_points = None
        self.card_index = 1
        self.card_sample = None
        self.card_centers = []
        self.card_refs = []
        self.card_pupils = []
        self.card_frame = None
        self.awaiting_world_since = None
        self.tracker_ready_notified = False
        self.session_id = ""
        self.purpose = "calibration"
        self.validation_points = []
        self.validation_report = None
        self.trained_audit = None
        self.validation_camera = None

    @property
    def verified(self) -> bool:
        return bool(self.token) and not self.pending

    def start(self, *, points=3) -> None:
        if self.network is None:
            raise UnsupportedCapability("A connected Capture calibration session is required")
        if self.pending:
            raise ValueError("Calibration is already running")
        if type(points) is not int or points not in (1, 3, 5, 9):
            raise ValueError("Pupil card calibration supports one, three, five or nine points")
        self.reset()
        # A video frame does not prove pupil detection is enabled. Remote ACK
        # only confirms delivery; point quality still requires real 3D data.
        self.network.enable_pupil_detection()
        logging.info("pupil.calibration detectors enable acknowledged; actual 3D samples still required")
        self.session_id = uuid.uuid4().hex
        self.card_points = points
        self.pending = True
        self.deadline = time.monotonic() + 300
        if self.tracker_factory is NaturalFeatureTracker:
            self.worker = self.worker_factory()
        logging.info("pupil.calibration card session started; points=%s", points)

    def start_validation(self, token):
        if not self.verified or token != self.token:
            raise ValueError("请先在当前连接完成校准，再进行独立验证")
        audit, receipt = self.snapshot(), self.token
        self.start(points=3)
        self.purpose = "validation"
        self.token = receipt
        self.trained_audit = audit
        if hasattr(self.network, 'calibration_camera'):
            self.validation_camera = self.network.calibration_camera()

    def _finish_validation(self):
        if len(self.validation_points) != 3:
            raise ValueError("请完成三个独立验证目标采样")
        a, b, c = self.card_centers
        area = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
        if area < .01:
            raise ValueError("独立验证目标过于集中，请重新测试分散的三个位置")
        errors = sorted(e for point in self.validation_points for e in point["errors_px"])
        total = sum(point["gaze_count"] for point in self.validation_points)
        if not errors:
            raise ValueError('独立验证有效样本为空，请重新采样')
        report = {"unit": "source_pixels", "meanErrorPx": sum(errors) / len(errors),
                  "medianErrorPx": errors[len(errors) // 2],
                  "p95ErrorPx": errors[min(len(errors) - 1, math.ceil(len(errors) * .95) - 1)],
                  "validityPercent": 100 * len(errors) / total if total else 0,
                  "matchedSamples": len(errors), "observedSamples": total,
                  "points": self.validation_points, "independentValidationPerformed": True,
                  "accuracyAcceptance": "not_configured", "angularAccuracyAvailable": False}
        from .angular_metrics import summarize_angles, camera_provenance
        if self.validation_camera is not None and all(p.get('angularAccuracyAvailable') for p in self.validation_points):
            metrics = {eye: summarize_angles([v for p in self.validation_points for v in p['angular']['errorsDeg'][eye]])
                       for eye in ('binocular', 'left', 'right')}
            for eye, metric in metrics.items():
                metric.update(validityPercent=100 * metric['samples'] / total if total else 0,
                              targetsWithSamples=sum(bool(p['angular']['errorsDeg'][eye]) for p in self.validation_points))
            report.update(angularAccuracyAvailable=True, angular={**camera_provenance(self.validation_camera),
                'metrics': metrics, 'pairing': 'held-out gaze timestamps with interpolated reference; not official closest-match pipeline',
                'metricFormulaAlignedWith': 'Pupil Core Accuracy Visualizer', 'officialPipelineEquivalent': False})
        report.update(calibrationToken=self.token, validationSession=self.session_id,
                      qualityScore=report.get('angular', {}).get('metrics', {}).get('binocular', {}).get('qualityScore'),
                      scoringPolicy=SCORING_POLICY)
        message = f"独立验证完成：平均偏差 {report['meanErrorPx']:.1f} px，P95 {report['p95ErrorPx']:.1f} px，有效率 {report['validityPercent']:.1f}%。"
        if report['angularAccuracyAvailable']:
            for key, label in (('binocular', '融合'), ('left', '左眼'), ('right', '右眼')):
                metric = report['angular']['metrics'][key]
                if metric['samples']:
                    official = metric['pupilCoreAccuracyDeg']
                    comparison = f"{official:.3f}°" if official is not None else '不可用'
                    message += (f"\n{label}独立验证分：{score_label(metric)}；平均角度误差 {metric['meanErrorDeg']:.3f}°，P95 {metric['p95ErrorDeg']:.3f}°；"
                                f"官方公式对照 {comparison}（<5°，使用 {metric['pupilCoreUsedSamples']}/{metric['samples']}）；"
                                f"覆盖 {metric['targetsWithSamples']}/3 个目标，有效率 {metric['validityPercent']:.1f}%。")
                else:
                    message += f'\n{label}独立验证分：不可用（无有效单眼角度样本）。'
            if not report['angular']['intrinsicsIndividuallyCalibrated']:
                message += '\n使用型号默认内参，尚非逐台实测内参。'
        else:
            report['angularUnavailableReasons'] = sorted({p.get('angularUnavailableReason') or 'missing_angular_samples'
                                                         for p in self.validation_points if not p.get('angularAccuracyAvailable')})
            message += '\n角度误差不可用：缺少匹配内参或有效角度样本。'
        message += '\n自定义分数：10−2×官方公式对照角度（°），限制1–10分，越高越好；非厂商评分。剔除样本不参与评分，请同时查看P95和有效率。尚未设置精度合格标准。'
        self._close_worker()
        self.pending = False
        self.validation_report = report
        return {"error": 0, "coe": self.token, "tracking_error": 0, "calibration_provider": "PupilCore",
                "calibration_session": self.session_id,
                "validation": report, "msg": message}

    def finish(self):
        if self.finishing:
            return
        if not self.pending or self.card_sample or self.card_index <= self.card_points:
            raise ValueError("Complete every card sample before fitting calibration")
        if self.purpose == "validation":
            return self._finish_validation()
        if self.card_points in (3, 5, 9):
            span_x = max(p[0] for p in self.card_centers) - min(p[0] for p in self.card_centers)
            span_y = max(p[1] for p in self.card_centers) - min(p[1] for p in self.card_centers)
            area = max(abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
                       for a, b, c in combinations(self.card_centers, 3))
            if min(span_x, span_y) < .15 or area < .01:
                raise ValueError('校准点覆盖不足：请重新校准，选择分散且不共线的位置')
        self._close_worker()
        self.source_start = self.network.source_time()
        self.network.fit_card_calibration(self.card_refs, self.card_pupils)
        self.finishing = True
        self.started = False
        self.deadline = time.monotonic() + getattr(self.network, 'fit_timeout_s', 15)
        logging.info("pupil.calibration fit requested; refs=%s pupils=%s", len(self.card_refs), len(self.card_pupils))

    def cancel(self):
        audit, token = self.trained_audit, self.token
        validation = self.purpose == "validation"
        self.reset()
        if validation and audit is not None:
            # Validation does not modify Capture's gaze mapper. An explicit
            # cancellation may retain the original fit, but never partial metrics.
            self.token, self.trained_audit = token, audit
            self.validation_report = audit.get("validation")
        logging.info("pupil.calibration canceled; retained_original_fit=%s", bool(self.token))

    def complete(self):
        if not self.verified:
            raise UnsupportedCapability("No verified Capture calibration result is available")
        return self.token

    def snapshot(self):
        if not self.verified:
            raise ValueError("Calibration audit requires a verified fit")
        if self.trained_audit is not None:
            return {**self.trained_audit, "independentValidationPerformed": self.validation_report is not None,
                    "validation": self.validation_report}
        return {"version": 2, "mode": "natural_feature", "referenceSpace": "world_normalized_bottom_left",
                "ref_list": self.card_refs, "pupil_list": self.card_pupils,
                "centers": self.card_centers, "success": self.success, "result": self.result,
                "independentValidationPerformed": False, "cameraIntrinsicsArchived": False,
                **(self.network.audit() if hasattr(self.network, 'audit') else {}),
                "points": self.card_points, "modelQualityChecked": True}

    def handle(self, message):
        subject = message.payload.get("subject")
        if message.topic != f"notify.{subject}":
            return None
        if not self.pending:
            if subject in ("calibration.started", "calibration.setup.v2"):
                self.token = ""
            return None
        if subject == "calibration.started":
            return self.fail("Capture started another calibration; retry from this software")
        if self.purpose == "validation" and subject == "calibration.setup.v2":
            return self.fail("Capture calibration changed during independent validation; recalibrate from this software")
        if not self.finishing:
            return None
        timestamp = message.payload.get("timestamp")
        if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
            return None
        if timestamp < self.source_start:
            return None
        if message.payload.get("gazer_class_name") != "Gazer3D":
            return None
        if subject == "calibration.setup.v2":
            self.started = message.payload.get("calib_data") == {
                "ref_list": self.card_refs, "pupil_list": self.card_pupils}
            return None
        if subject == "calibration.failed":
            return self.fail(str(message.payload.get("reason", "Capture calibration failed")))
        if not self.started or not isinstance(message.payload.get("gazer_class_name"), str):
            return None
        if subject == "calibration.successful":
            self.success = message.payload
        elif message.payload.get("version") == 2 and isinstance(message.payload.get("params"), dict):
            self.result = message.payload
        if self.success and self.result and self.success["gazer_class_name"] == self.result["gazer_class_name"]:
            if self.awaiting_world_since is None:
                self.awaiting_world_since = time.monotonic()
                self.deadline = self.awaiting_world_since + self.resume_timeout_s
                logging.info("pupil.calibration fit verified; waiting for fresh world video")
        return None

    def fail(self, reason):
        if getattr(self.network, 'backend', '') == 'native':
            reason = reason.replace('Capture', 'Pupil 原生后端')
        logging.warning("pupil.calibration failed: %s", reason)
        session = self.session_id
        self.reset()
        return {"error": -1, "msg": reason, "calibration_provider": "PupilCore", "calibration_session": session}

    def _close_worker(self):
        if self.worker is not None:
            self.worker.close()
            self.worker = None

    def _poll_feature(self):
        if self.worker is None:
            return
        for reply in self.worker.poll():
            sample = self.card_sample
            if sample is None or reply.get("sample_id") != sample["sample_id"]:
                continue
            if reply["kind"] == "error":
                sample["worker_error"] = reply["reason"]
            elif reply["kind"] == "initialized":
                sample["initialized"] = True
                sample["until"] = time.monotonic() + 1
            elif reply["kind"] == "frame" and reply["received"] <= sample["until"]:
                self._reference(sample, reply["position"], reply["timestamp"], reply["width"], reply["height"])
        sample = self.card_sample
        if sample is None:
            return
        if self.worker.error:
            sample["worker_error"] = self.worker.error
        if not sample.get("init_sent") and not sample.get("worker_error") and self.worker.ready:
            if time.monotonic() - sample["seed"].received_monotonic_s > .25:
                sample["worker_error"] = "追踪器已就绪，请重新点击当前目标采样"
            elif self.worker.submit(sample["sample_id"], "init", sample["seed"], (sample["x"], sample["y"])):
                sample["init_sent"] = True

    def _reference(self, sample, position, timestamp, width, height):
        if position is None:
            sample["tracking_lost"] = True
            return
        if sample.get("tracking_lost") or sample.get("geometry_changed") or sample.get("worker_error"):
            return
        x, y = position
        if len(sample["refs"]) < 120:
            sample["refs"].append({"timestamp": timestamp, "norm_pos": [x / width, 1 - y / height],
                                   "screen_pos": [x, y]})

    def tick(self):
        self._poll_feature()
        if self.pending and self.worker is not None and self.worker.error and self.card_sample is None:
            return self.fail(self.worker.error)
        if self.pending and self.worker is not None and self.worker.ready and not self.tracker_ready_notified:
            self.tracker_ready_notified = True
            return {"id": "calibration_ready", "error": 0, "calibration_provider": "PupilCore",
                    "calibration_session": self.session_id}
        if (self.card_sample and self.card_sample["initialized"] and self.worker is not None and self.worker.busy
                and self.card_sample["until"] <= time.monotonic() < self.card_sample["until"] + .2
                and not self.card_sample.get("worker_error") and not self.card_sample.get("tracking_lost")):
            return None
        if self.card_sample and (time.monotonic() >= self.card_sample["until"] or
                                 self.card_sample.get("worker_error") or self.card_sample.get("tracking_lost") or
                                 self.card_sample.get("geometry_changed")):
            sample = self.card_sample
            self.card_sample = None
            candidates = len(sample["pupils"])
            reference_window = None
            # Only pair pupil data with the source-time interval actually covered by tracked world frames.
            if sample["refs"]:
                begin, end = sample["refs"][0]["timestamp"], sample["refs"][-1]["timestamp"]
                reference_window = [begin, end]
                sample["pupils"] = [p for p in sample["pupils"] if begin - .05 <= p["timestamp"] <= end + .05]
            eye_counts = [sum(p.get("id") == eye for p in sample["pupils"]) for eye in (0, 1)]
            diagnostics = sample["pupil_diagnostics"].report(eye_counts)
            diagnostics.update(reference_window_s=reference_window,
                               outside_reference_window=candidates - len(sample["pupils"]))
            ok = (not sample.get("geometry_changed") and not sample.get("tracking_lost")
                  and not sample.get("worker_error") and (self.worker is None or not self.worker.busy) and len(sample["refs"]) >= 10 and min(eye_counts) >= 10)
            # A handful of good pupils cannot hide a mostly invalid model.
            window_counts = sample["pupil_diagnostics"].window_counts(reference_window)
            ratios = [eye_counts[eye] / max(1, window_counts[eye])
                      for eye in (0, 1)]
            stable = bool(sample["refs"]) and all(max(r["norm_pos"][axis] for r in sample["refs"]) -
                         min(r["norm_pos"][axis] for r in sample["refs"]) <= .025 for axis in (0, 1))
            center = [sum(r["norm_pos"][axis] for r in sample["refs"]) / len(sample["refs"]) for axis in (0, 1)] if sample["refs"] else None
            ok = ok and min(ratios) >= .8 and stable
            diagnostics.update(paired_fraction_by_eye=ratios, window_samples_by_eye=window_counts, target_stable=stable,
                               tracked_center_top_left=[center[0], 1 - center[1]] if center else None,
                               target_region_required=False, target_region_ok=True, target_bounds_top_left=None)
            validation = None
            if self.purpose == "validation" and sample["refs"]:
                from .validation import measure_target
                validation = measure_target(sample["refs"], sample["gaze"], sample["size"], self.validation_camera)
                ok = ok and len(validation["errors_px"]) >= 10
                # A new validation session must sample held-out positions rather
                # than silently reusing the training target footprint.
                reused = center is not None and any(math.dist(center, old) <= .025
                    for old in (self.trained_audit or {}).get('centers', []))
                diagnostics['validation_target_reuses_training'] = reused
                ok = ok and not reused
            if ok:
                if validation is not None:
                    self.validation_points.append(validation)
                self.card_centers.append(tuple(sum(ref["norm_pos"][axis] for ref in sample["refs"]) /
                                               len(sample["refs"]) for axis in (0, 1)))
                self.card_refs.extend(sample["refs"])
                self.card_pupils.extend(sample["pupils"])
                self.card_index += 1
            logging.info("pupil.calibration card sample; index=%s refs=%s pupils=%s accepted=%s",
                         sample["index"], len(sample["refs"]), len(sample["pupils"]), ok)
            logging.info("pupil.calibration pupil diagnostics; index=%s attempt=%s data=%s",
                         sample["index"], sample["attempt"], diagnostics)
            if ok:
                reason = "ok"
            elif sample.get("worker_error"):
                reason = sample["worker_error"]
            elif not sample.get("initialized", True):
                reason = "追踪初始化超时，请稍后重试当前点；视频连接保持开启"
            elif self.worker is not None and self.worker.busy:
                reason = "追踪计算超时，请重新启动校准；视频连接保持开启"
            elif sample.get("geometry_changed"):
                reason = "场景视频分辨率发生变化，请重新采样当前点"
            elif sample.get("tracking_lost"):
                reason = "目标追踪丢失，请等待识别实体卡片中心后点击校准按钮重试"
            elif not stable:
                reason = "目标移动过大，请保持头部和实体卡片稳定后重试当前点"
            elif min(ratios) < .8 and min(eye_counts) >= 10:
                reason = f"双眼高质量 3D 样本比例不足 80%（右眼 {ratios[0]:.0%} / 左眼 {ratios[1]:.0%}），请检查检测及眼球模型后重试当前点"
            elif self.purpose == "validation" and validation is not None and len(validation["errors_px"]) < 10:
                reason = "独立验证有效注视样本不足，请检查模型质量并继续注视实体卡片中心"
            elif diagnostics.get('validation_target_reuses_training'):
                reason = '独立验证位置与训练目标重合，请选择不同的分散位置'
            else:
                reason = (sample["pupil_diagnostics"].failure_message(eye_counts) if min(eye_counts) < 10
                          else "场景参考帧采样不足，请保持头部和卡片稳定后重试当前点")
            if not ok:
                reason += f"；当前第 {sample['index']}/{self.card_points} 点，已完成 {self.card_index - 1} 点保留。可自由调整卡片位置，注视中心并稳定后点击校准按钮重试"
            return {"id": "start_calibration_point", "error": 0 if ok else -1,
                    "calibration_provider": "PupilCore",
                    "calibration_session": self.session_id,
                    "index": sample["index"], "attempt": sample["attempt"], "point_pending": False,
                    "msg": reason, "pupil_diagnostics": diagnostics}
        if self.pending and time.monotonic() >= self.deadline:
            reason = ("Capture fitting succeeded but world video did not resume; reconnect and retry"
                      if self.awaiting_world_since is not None else
                      "Capture calibration timed out; check Capture and retry" if self.finishing else
                      f"卡片采样会话超时（已完成 {self.card_index - 1}/{self.card_points} 点，尚未提交 Capture 拟合），请检查双眼检测后重新开始校准")
            return self.fail(reason)
        return None

    def sample_card_point(self, index, x, y, attempt):
        if not self.pending or self.card_points is None or self.finishing:
            raise ValueError("Start card calibration before selecting a point")
        if type(index) is not int or index != self.card_index or type(attempt) is not int or attempt < 1:
            raise ValueError("Invalid card sample index or attempt")
        if any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in (x, y)):
            raise ValueError("Card point must be inside the scene image")
        if self.card_sample:
            raise ValueError("The current card point is still sampling")
        if not self.card_frame or time.monotonic() - self.card_frame.received_monotonic_s > .5:
            raise ValueError("No fresh scene frame; reconnect the camera")
        if self.worker is not None and self.worker.error:
            raise ValueError(self.worker.error)
        if self.worker is not None and not self.worker.ready:
            raise ValueError('目标追踪正在初始化，请稍后点击校准按钮；视频连接保持开启')
        tracker = None if self.worker is not None else self.tracker_factory(self.card_frame, x, y)
        self.card_sample = {"tracker": tracker, "index": index, "attempt": attempt, "x": x, "y": y,
                            "start": self.card_frame.payload["timestamp"],
                            "size": (self.card_frame.payload["width"], self.card_frame.payload["height"]),
                            "until": time.monotonic() + (5 if self.worker is not None else 1),
                            "initialized": self.worker is None, "sample_id": uuid.uuid4().hex,
                            "seed": self.card_frame, "refs": [], "pupils": [],
                            "gaze": [],
                            "pupil_diagnostics": PupilDiagnostics()}
        logging.info("pupil.calibration point queued; index=%s attempt=%s isolated=%s", index, attempt, self.worker is not None)
        self._poll_feature()

    def observe_card_data(self, message):
        self._poll_feature()
        if self.pending and self.awaiting_world_since is not None and message.topic == "frame.world":
            timestamp = message.payload.get("timestamp")
            if (message.received_monotonic_s >= self.awaiting_world_since and
                    type(timestamp) in (int, float) and math.isfinite(timestamp) and
                    timestamp > max(self.success["timestamp"], self.result["timestamp"]) and
                    time.monotonic() < self.deadline):
                self.pending = False
                self.token = "pupil-session:" + uuid.uuid4().hex
                logging.info("pupil.calibration verified; fresh world video resumed")
                scores = {}
                metrics = self.result.get('params', {}).get('training_reprojection')
                if getattr(self.network, 'backend', '') == 'native' and isinstance(metrics, dict):
                    for eye in ('left', 'right'):
                        value = metrics.get(eye, {}).get('mean_error_px')
                        if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                            scores[f'{eye}_score'] = value
                    if scores:
                        scores['score_semantics'] = 'training_reprojection_error_px'
                        scores['score_description'] = '左右眼数值为校准训练平均重投影误差（像素，越小越好），不是独立精度得分。'
                        scores['calibration_metrics'] = metrics
                angular = self.result.get('params', {}).get('training_angular')
                message = '校准拟合完成，请使用不同目标进行独立验证。'
                if isinstance(angular, dict):
                    scores['training_angular'] = angular
                    for key, label in (('binocular', '融合'), ('left', '左眼'), ('right', '右眼')):
                        metric = angular.get('metrics', {}).get(key, {})
                        value = metric.get('meanErrorDeg')
                        if type(value) in (int, float) and math.isfinite(value):
                            message += f'\n{label}校准训练分：{score_label(metric)}；平均训练角度误差：{value:.3f}°。'
                            official = metric.get('pupilCoreAccuracyDeg')
                            if type(official) in (int, float) and math.isfinite(official):
                                message += f"官方公式对照：{official:.3f}°（<5°，使用 {metric['pupilCoreUsedSamples']}/{metric['samples']}）。"
                    if not angular.get('intrinsicsIndividuallyCalibrated'):
                        message += '\n使用型号默认内参，尚非逐台实测内参。'
                    message += '\n自定义分数：10−2×官方公式对照角度（°），限制1–10分，越高越好；非厂商评分。以上仅为训练结果，未独立验证，不代表精度达标。'
                return {"error": 0, "msg": message, "coe": self.token,
                        "calibration_session": self.session_id,
                        "tracking_error": 0, "calibration_provider": "PupilCore", **scores}
        if self.card_points is None or not self.pending or self.finishing:
            return
        if message.topic == "frame.world":
            self.card_frame = message
        sample = self.card_sample
        if sample is None or message.received_monotonic_s > sample["until"]:
            return
        data = message.payload
        if message.topic.startswith("pupil."):
            if sample["pupil_diagnostics"].observe(message, sample["start"]) and len(sample["pupils"]) < 1000:
                sample["pupils"].append(data)
            return
        if self.purpose == "validation" and message.topic.startswith("gaze"):
            if len(sample["gaze"]) < 1000:
                sample["gaze"].append(message.payload)
            return
        timestamp = data.get("timestamp")
        if type(timestamp) not in (int, float) or not math.isfinite(timestamp) or timestamp <= sample["start"]:
            return
        if message.topic == "frame.world" and (data.get("width"), data.get("height")) != sample["size"]:
            sample["geometry_changed"] = True
            return
        if sample.get("geometry_changed") or sample.get("tracking_lost"):
            return
        if message.topic == "frame.world":
            if self.worker is not None:
                if sample["initialized"] and not sample.get("worker_error"):
                    self.worker.submit(sample["sample_id"], "frame", message)
            else:
                self._reference(sample, sample["tracker"].update(message), timestamp, data["width"], data["height"])
