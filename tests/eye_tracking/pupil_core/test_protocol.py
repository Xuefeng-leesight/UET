import json
import queue
import subprocess
import sys
import threading
import time
import unittest

import msgpack
import zmq

from services.eye_tracking.domain.contracts import EyeTrackingError, UnsupportedCapability
from services.eye_tracking.domain.samples import EyeEventSample, GazeSample, VideoFrame
from services.eye_tracking.adapters.pupil_core.calibration import PupilCalibration
from services.eye_tracking.adapters.pupil_core.data_normalizer import DataNormalizer
from services.eye_tracking.adapters.pupil_core.frame_receiver import decode_frame
from services.eye_tracking.adapters.pupil_core.network import (
    NetworkConfig, PupilNetwork, PupilProtocolError, PupilTimeout, decode_message,
)
from services.eye_tracking.adapters.pupil_core.service import PupilService


def multipart(topic="frame.world", **overrides):
    payload = {"topic": topic, "timestamp": 10.0}
    if topic.startswith("frame."):
        payload.update(format="bgr", width=2, height=1, index=0)
    else:
        payload.update(norm_pos=[0.25, 0.75], confidence=0.9, base_data=[{"id": 0}, {"id": 1}])
    payload.update(overrides)
    parts = [topic.encode(), msgpack.packb(payload, use_bin_type=True)]
    if topic.startswith("frame."):
        parts.append(bytes([1, 2, 3, 4, 5, 6]))
    return parts


def message(topic="frame.world", **overrides):
    return decode_message(multipart(topic, **overrides), max_bytes=1024 * 1024)


class ContractTests(unittest.TestCase):
    def test_import_isolation_without_site_packages(self):
        script = """
import json, sys
import services.eye_tracking.adapters.pupil_core.service
import services.eye_tracking.domain.contracts
print(json.dumps([m for m in sys.modules if m.startswith(('zmq', 'msgpack', 'cv2', 'numpy')) or 'sdk_service' in m or 'sdk_driver' in m]))
"""
        output = subprocess.check_output([sys.executable, "-S", "-c", script], text=True)
        self.assertEqual(json.loads(output), [])

    def test_probe_missing_dependencies_reports_failure(self):
        result = subprocess.run(
            [sys.executable, "-S", "-m", "tests.eye_tracking.pupil_core.tools.probe"],
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "failed")
        self.assertFalse(report["product_integration"])
        self.assertIn("isolated Pupil requirements", report["error"])

    def test_bgr_source_identity_and_eye_mapping(self):
        for topic, stream in (("frame.world", "scene"), ("frame.eye.0", "right_eye"), ("frame.eye.1", "left_eye")):
            frame = decode_frame(message(topic), 2, 3)
            self.assertEqual(frame.stream, stream)
            self.assertEqual(frame.identity.source_time_s, 10)
            self.assertEqual(frame.identity.generation, 2)
            self.assertEqual(frame.identity.received_sequence, 3)
            self.assertEqual(frame.pixels, bytes([1, 2, 3, 4, 5, 6]))

    def test_reject_malformed_frames(self):
        for overrides in ({"format": "jpeg"}, {"width": True}, {"height": 0}, {"width": 3},
                          {"timestamp": float("nan")}, {"timestamp": None}, {"index": -1}):
            with self.subTest(overrides=overrides), self.assertRaises(PupilProtocolError):
                decode_frame(message(**overrides), 1, 1)
        for count in (2, 4):
            parts = multipart()
            parts = parts[:count] if count == 2 else parts + [b"extra"]
            with self.assertRaises(PupilProtocolError):
                decode_frame(decode_message(parts, max_bytes=4096), 1, 1)

    def test_reject_malformed_envelopes(self):
        for parts in ([b"gaze"], [b"\xff", b"x"], [b"gaze", b"\xc1"],
                      [b"gaze", msgpack.packb([1, 2])],
                      [b"gaze", msgpack.packb({"topic": "pupil.0"})]):
            with self.subTest(parts=parts), self.assertRaises(PupilProtocolError):
                decode_message(parts, max_bytes=4096)
        with self.assertRaises(PupilProtocolError):
            decode_message(multipart(), max_bytes=1)

    def test_gaze_never_fabricates_missing_or_off_scene_data(self):
        normalizer = DataNormalizer()
        valid = normalizer.normalize(message("gaze.3d.01."), 1, 2)
        self.assertEqual(valid.position, (0.25, 0.75))
        self.assertEqual(valid.coordinate_space, "world_normalized_bottom_left")
        self.assertEqual(valid.contributing_eyes, ("left", "right"))
        self.assertTrue(valid.valid)
        for overrides in ({"norm_pos": None}, {"norm_pos": [float("inf"), 1]},
                          {"norm_pos": [1.1, 0.2]}, {"confidence": 0.2}, {"confidence": True},
                          {"confidence": 2}, {"norm_pos": [True, 0.3]}):
            with self.subTest(overrides=overrides):
                self.assertFalse(normalizer.normalize(message("gaze", **overrides), 1, 1).valid)
        outside = normalizer.normalize(message("gaze", norm_pos=[1.1, -0.1]), 1, 1)
        self.assertEqual(outside.position, (1.1, -0.1))

    def test_pupil_pixel_and_millimeter_fields_are_independent(self):
        normalizer = DataNormalizer()
        pixel_only = normalizer.normalize(message("pupil.0.2d", id=0, diameter=40), 1, 1)
        self.assertEqual(pixel_only.eye, "right")
        self.assertEqual(pixel_only.diameter_px, 40)
        self.assertIsNone(pixel_only.diameter_mm)
        metric = normalizer.normalize(message("pupil.1.3d", id=1, diameter=40, diameter_3d=3.2), 1, 1)
        self.assertEqual(metric.eye, "left")
        self.assertEqual(metric.diameter_mm, 3.2)
        with self.assertRaises(PupilProtocolError):
            normalizer.normalize(message("pupil.0.3d", id=1), 1, 1)

    def test_calibration_fails_closed(self):
        calibration = PupilCalibration()
        self.assertFalse(calibration.verified)
        self.assertEqual(PupilService.capabilities.calibration_modes, ("capture",))
        for action in (calibration.start, calibration.complete):
            with self.assertRaises(UnsupportedCapability):
                action()

    def test_invalid_configuration(self):
        for kwargs in ({"remote_port": 0}, {"remote_port": 65536}, {"remote_port": True},
                       {"host": "example.com"}, {"request_timeout_ms": -1}, {"frame_hwm": 0}):
            with self.assertRaises(ValueError):
                NetworkConfig(**kwargs)
        for threshold in (float("nan"), -1, 2, True):
            with self.assertRaises(ValueError):
                DataNormalizer(threshold)


class MockCapture:
    """Actual REP/PUB sockets, all created/used/closed on one worker thread."""

    def __init__(self, *, frames=True, port_reply=None, video_size=(2, 1), version="3.5.1-test",
                 auto_calibration=False, live_clock=False,
                 notification_reply="Message forwarded.", pupil_detection=True, realistic_rates=False):
        self.frames = threading.Event()
        if frames:
            self.frames.set()
        self.port_reply = port_reply
        self.video_size = (160, 120) if auto_calibration and video_size == (2, 1) else video_size
        self.version = version
        self.notification_reply = notification_reply
        self.auto_calibration = auto_calibration
        self.live_clock = live_clock
        self.pupil_detection = pupil_detection
        self.realistic_rates = realistic_rates
        self.notifications = queue.Queue()
        self.stop = threading.Event()
        self.ready = threading.Event()
        self.slow_query = threading.Event()
        self.slow_reply_sent = threading.Event()
        self.regress_clock = threading.Event()
        self.requests = []
        self.calibrations = []
        self.error = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        if not self.ready.wait(3):
            raise RuntimeError("Mock Capture failed to start")
        if self.error:
            raise self.error
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.thread.join(3)
        if self.thread.is_alive():
            raise RuntimeError("Mock Capture failed to stop")
        if self.error:
            raise self.error

    def run(self):
        context = zmq.Context()
        remote, publisher = context.socket(zmq.REP), context.socket(zmq.PUB)
        try:
            self.remote_port = remote.bind_to_random_port("tcp://127.0.0.1")
            sub_port = publisher.bind_to_random_port("tcp://127.0.0.1")
            self.ready.set()
            index = 0
            last_world = last_data = 0
            while not self.stop.is_set():
                source_time = time.monotonic() if self.realistic_rates else (10 + index / 30 if self.live_clock else 42.5)
                if remote.poll(1 if self.realistic_rates else 5):
                    parts = remote.recv_multipart()
                    request = parts[0].decode()
                    self.requests.append(request)
                    if request == "notify.pupil_detector.set_enabled":
                        notification = msgpack.unpackb(parts[1], raw=False)
                        if notification != {"subject": "pupil_detector.set_enabled", "value": True}:
                            raise ValueError("Unexpected pupil detector control")
                        self.pupil_detection = True
                        remote.send_string(self.notification_reply)
                        continue
                    if request == "notify.start_plugin":
                        notification = msgpack.unpackb(parts[1], raw=False)
                        if notification.get("name") == "Gazer3D":
                            data = notification["args"]["calib_data"]
                            if not data["ref_list"] or not data["pupil_list"]:
                                raise ValueError("Empty card calibration data")
                            self.calibrations.append(data)
                            remote.send_string(self.notification_reply)
                            if self.auto_calibration:
                                for subject in ("calibration.setup.v2", "calibration.successful", "calibration.result.v2"):
                                    self.notifications.put({"subject": subject, "timestamp": source_time,
                                                            "gazer_class_name": "Gazer3D", "version": 2,
                                                            "params": {"test": True}, "calib_data": data})
                            continue
                        raise ValueError("Unexpected calibration plugin configuration")
                    if request == "t" and self.slow_query.is_set():
                        self.stop.wait(0.15)
                        self.slow_query.clear()
                    reply = {"v": self.version, "SUB_PORT": self.port_reply or str(sub_port), "t": str(source_time),
                             "C": "Calibration started.", "c": "Calibration stopped."}.get(request, "unexpected")
                    remote.send_string(reply)
                    if request == "t":
                        self.slow_reply_sent.set()
                timestamp = time.monotonic() if self.realistic_rates else 10 + index / 30
                if self.frames.is_set() and (not self.realistic_rates or timestamp - last_world >= 1 / 30):
                    last_world = timestamp
                    timestamp = -100 if self.regress_clock.is_set() else timestamp
                    width, height = self.video_size
                    video_parts = multipart(timestamp=timestamp, index=index, width=width, height=height)
                    if self.auto_calibration:
                        # Textured stationary scene for production optical-flow calibration tests.
                        video_parts[2] = bytes(channel for y in range(height) for x in range(width)
                                              for channel in ([220] * 3 if (x // 8 + y // 8) % 2 else [30] * 3))
                    else:
                        video_parts[2] = bytes([0, 0, 255]) * width * height
                    publisher.send_multipart(video_parts)
                if not self.realistic_rates or timestamp - last_data >= 1 / 120:
                    last_data = timestamp
                    publisher.send_multipart(multipart("gaze.3d.01.", timestamp=timestamp))
                    for eye in (0, 1):
                        if self.pupil_detection:
                            publisher.send_multipart(multipart(f"pupil.{eye}.2d", timestamp=timestamp,
                                                               id=eye, confidence=.9, method="2d c++"))
                            publisher.send_multipart(multipart(f"pupil.{eye}.3d", timestamp=timestamp,
                                                               id=eye, confidence=.9, sphere={"center": [0, 0, 30]}, model_confidence=1, diameter_3d=3,
                                                               circle_3d={"normal": [0, 0, 1]}, method="pye3d real-time"))
                if not self.notifications.empty():
                    notification = self.notifications.get_nowait()
                    topic = notification.get("topic") or f"notify.{notification['subject']}"
                    publisher.send_multipart([topic.encode(), msgpack.packb(notification)])
                index += 1
        except Exception as exc:
            self.error = exc
            self.ready.set()
        finally:
            remote.close(linger=0)
            publisher.close(linger=0)
            context.term()

    def config(self, **kwargs):
        return NetworkConfig(remote_port=self.remote_port, **kwargs)


class NetworkIntegrationTests(unittest.TestCase):
    def test_high_rate_pupils_pair_with_world_frames_under_slow_consumer(self):
        from tests.eye_tracking.pupil_core.test_calibration import StaticTracker
        with MockCapture(realistic_rates=True) as capture:
            service = PupilService(capture.config())
            try:
                service.connect()
                service.calibration.tracker_factory = StaticTracker
                service.calibration.start(points=1)
                def acquire():
                    service.read(10)
                    for msg in service.last_messages:
                        service.calibration.observe_card_data(msg)
                # Model per-turn decoding/recording work while keeping world
                # video at 30 Hz and the mixed pupil/gaze stream at ~600 Hz.
                warmup = time.monotonic() + .5
                while time.monotonic() < warmup:
                    acquire()
                    time.sleep(.015)
                service.calibration.sample_card_point(1, .25, .3, 1)
                deadline = time.monotonic() + 2
                result = None
                while time.monotonic() < deadline and result is None:
                    acquire()
                    result = service.calibration.tick()
                    time.sleep(.015)
                self.assertIsNotNone(result)
                self.assertEqual(result["error"], 0, result)
                self.assertTrue(all(n >= 10 for n in result["pupil_diagnostics"]["paired_by_eye"]))
                self.assertGreaterEqual(len(service.calibration.card_refs), 10)
                self.assertEqual(service.state, "ready")
            finally:
                service.close()

    def test_calibration_enables_detectors_but_video_start_is_read_only(self):
        from tests.eye_tracking.pupil_core.test_calibration import StaticTracker
        with MockCapture(pupil_detection=False) as capture:
            service = PupilService(capture.config())
            try:
                service.connect()
                self.assertEqual(capture.requests, ["v", "SUB_PORT"])
                service.calibration.tracker_factory = StaticTracker
                service.calibration.start(points=1)
                self.assertIn("notify.pupil_detector.set_enabled", capture.requests)
                received = set()
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and len(received) < 4:
                    service.read(20)
                    received.update(m.topic for m in service.last_messages if m.topic.startswith("pupil."))
                self.assertEqual(received, {f"pupil.{eye}.{mode}" for eye in (0, 1) for mode in ("2d", "3d")})
                self.assertFalse(service.calibration.verified)
            finally:
                service.close()

    def test_bounded_data_burst_also_receives_video_and_notifications(self):
        with MockCapture() as capture:
            network = PupilNetwork(capture.config())
            try:
                network.open()
                # Accumulate real mixed 2D/3D/gaze traffic; one message per poll
                # would leave the data stream behind while video advances.
                time.sleep(.15)
                capture.notifications.put({"subject": "calibration.successful", "timestamp": 11})
                time.sleep(.05)
                messages = network.receive(50)
                data = [m for m in messages if m.topic.startswith(("pupil.", "gaze"))]
                self.assertGreater(len(data), 1)
                self.assertLessEqual(len(data), 64)
                self.assertEqual(len([m for m in messages if m.topic == "frame.world"]), 1)
                self.assertTrue(any(m.topic == "notify.calibration.successful" for m in messages))
                self.assertEqual({m.topic for m in data if m.topic.startswith("pupil.")},
                                 {f"pupil.{eye}.{mode}" for eye in (0, 1) for mode in ("2d", "3d")})
            finally:
                network.close()

    def test_card_fit_accepts_known_acks_and_rejects_other_replies(self):
        for reply in ("Message forwarded.", "Notification received", "Unknown command", ""):
            with self.subTest(reply=reply), MockCapture(notification_reply=reply) as capture:
                service = PupilService(capture.config())
                try:
                    service.connect()
                    if reply in ("Message forwarded.", "Notification received"):
                        service.network.fit_card_calibration([{"timestamp": 10}], [{"id": 0}])
                        self.assertFalse(service.calibration.pending)
                        self.assertFalse(service.calibration.verified)
                    else:
                        with self.assertRaises(PupilProtocolError):
                            service.network.fit_card_calibration([{"timestamp": 10}], [{"id": 0}])
                        self.assertFalse(service.calibration.pending)
                        self.assertFalse(service.calibration.verified)
                finally:
                    service.close()

    def test_event_channel_preserves_gaze_and_video(self):
        with MockCapture() as capture:
            service = PupilService(capture.config())
            try:
                service.connect()
                for payload in ({"topic": "fixations", "id": 0, "duration": 300, "norm_pos": [0.2, 0.4]},
                                {"topic": "blinks", "type": "onset"}):
                    capture.notifications.put({**payload, "timestamp": 10, "confidence": .9})
                samples = []
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and len([s for s in samples if isinstance(s, EyeEventSample)]) < 2:
                    samples.extend(service.read())
                self.assertEqual({s.kind for s in samples if isinstance(s, EyeEventSample)}, {"fixation", "blink"})
                self.assertTrue(any(isinstance(s, VideoFrame) for s in samples))
                self.assertTrue(any(isinstance(s, GazeSample) for s in samples))
            finally:
                service.close()

    def test_probe_runs_against_mock_capture(self):
        with MockCapture() as capture:
            result = subprocess.run(
                [sys.executable, "-m", "tests.eye_tracking.pupil_core.tools.probe",
                 "--port", str(capture.remote_port), "--seconds", "0.1", "--require-gaze"],
                capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "acquisition_probe_passed")
            self.assertFalse(report["product_integration"])
            self.assertFalse(report["calibration_verified"])
            self.assertGreater(report["received_by_topic"]["frame.world"], 0)
            self.assertTrue(set(capture.requests).issubset({"v", "SUB_PORT"}))

    def test_real_socket_acquisition_and_reconnection_generation(self):
        with MockCapture() as capture:
            service = PupilService(capture.config(), first_frame_timeout_s=2)
            try:
                for generation in (1, 2):
                    service.connect()
                    self.assertEqual(service.state, "ready")
                    self.assertFalse(service.calibration.verified)
                    samples = []
                    deadline = time.monotonic() + 1
                    while time.monotonic() < deadline and not (
                        any(isinstance(s, GazeSample) for s in samples) and any(isinstance(s, VideoFrame) for s in samples)
                    ):
                        samples.extend(service.read())
                    self.assertTrue(any(isinstance(s, GazeSample) for s in samples))
                    self.assertTrue(any(isinstance(s, VideoFrame) for s in samples))
                    self.assertTrue(all(s.identity.generation == generation for s in samples))
                    service.close()
                self.assertEqual(capture.requests, ["v", "SUB_PORT", "v", "SUB_PORT"])
            finally:
                service.close()

    def test_gaze_without_video_does_not_report_ready(self):
        with MockCapture(frames=False) as capture:
            service = PupilService(capture.config(), first_frame_timeout_s=0.2)
            with self.assertRaises(PupilTimeout):
                service.connect()
            self.assertEqual(service.state, "failed")
            self.assertIsNone(service.network._context)

    def test_bad_discovery_response_releases_resources(self):
        with MockCapture(port_reply="not-a-port") as capture:
            network = PupilNetwork(capture.config())
            with self.assertRaises(PupilProtocolError):
                network.open()
            self.assertIsNone(network._context)

    def test_timeout_recreates_req_socket_before_next_query(self):
        with MockCapture() as capture:
            network = PupilNetwork(capture.config(request_timeout_ms=50))
            try:
                network.open()
                capture.slow_query.set()
                with self.assertRaises(PupilTimeout):
                    network.source_time()
                self.assertIsNone(network._remote)
                self.assertTrue(capture.slow_reply_sent.wait(1))
                self.assertEqual(network.source_time(), 42.5)
                for command in ("R", "r", "C", "c", "T 0"):
                    with self.assertRaises(ValueError):
                        network.query(command)
            finally:
                network.close()

    def test_video_interruption_and_clock_regression_fail_closed(self):
        for regression in (False, True):
            with self.subTest(regression=regression), MockCapture() as capture:
                service = PupilService(capture.config(), frame_timeout_s=0.15)
                try:
                    service.connect()
                    if regression:
                        capture.regress_clock.set()
                    else:
                        capture.frames.clear()
                    deadline = time.monotonic() + 2
                    with self.assertRaises((PupilProtocolError, PupilTimeout)):
                        while time.monotonic() < deadline:
                            service.read(20)
                    self.assertEqual(service.state, "failed")
                    self.assertIsNone(service.network._context)
                finally:
                    service.close()

    def test_wrong_thread_cannot_change_state_or_close_sockets(self):
        with MockCapture() as capture:
            service = PupilService(capture.config())
            errors = []
            try:
                service.connect()
                def wrong_thread():
                    try:
                        service.read()
                    except EyeTrackingError as exc:
                        errors.append(str(exc))
                worker = threading.Thread(target=wrong_thread)
                worker.start()
                worker.join(1)
                self.assertEqual(len(errors), 1)
                self.assertEqual(service.state, "ready")
                self.assertTrue(service.read())
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
