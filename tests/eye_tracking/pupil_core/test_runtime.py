import threading
import asyncio
import csv
import io
import json
import os
from pathlib import Path
import tempfile
import shutil
import subprocess
import socket
import sys
import time
import unittest
from unittest.mock import patch

from PIL import Image
from websockets.asyncio.client import connect

from services.eye_tracking.adapters.pupil_core.feature_worker import FeatureWorker
from services.eye_tracking.adapters.pupil_core.frame_receiver import decode_frame
from services.eye_tracking.adapters.pupil_core.network import NetworkConfig, decode_message
from services.eye_tracking.application.pupil_runtime import PupilRuntime
from services.eye_tracking.infrastructure.recording_paths import RecordingPaths
from services.eye_tracking.transport.pupil_runtime import PupilWebSocketServer
from tests.eye_tracking.pupil_core.test_protocol import MockCapture, multipart


class HungTracker:
    def __init__(self, *_):
        time.sleep(30)

    def update(self, message):
        time.sleep(30)


class ProductionRuntimeTests(unittest.TestCase):
    def sample_cards(self, runtime, points=1):
        self.assertEqual(runtime.request("start_calibration", {"points": points}).result(3)["error"], 0)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not runtime.service.calibration.worker.ready:
            time.sleep(.02)
        self.assertTrue(runtime.service.calibration.worker.ready, 'isolated tracker startup')
        for index in range(1, points + 1):
            time.sleep(.05)
            response = runtime.request("start_calibration_point", {"index": index, "attempt": 1,
                                                                   "x": [.2, .8, .5][index - 1], "y": [.25, .25, .75][index - 1]}).result(3)
            self.assertEqual(response["error"], 0, response)
            self.assertTrue(response["point_pending"])
            point = runtime.events.get(timeout=3)
            if point.get('id') == 'calibration_ready':
                point = runtime.events.get(timeout=3)
            self.assertEqual(point["id"], "start_calibration_point")
            self.assertEqual(point["error"], 0, point)
            self.assertFalse(runtime.service.calibration.verified)
        response = runtime.request("complete_calibration").result(3)
        self.assertEqual(response["error"], 0, response)
        self.assertTrue(response["result_pending"])
        return runtime.events.get(timeout=3)

    def test_hung_tracker_keeps_video_and_commands_alive_and_can_be_canceled(self):
        for cancel in (True, False):
            with MockCapture() as capture:
                runtime = PupilRuntime(capture.config())
                runtime.service.calibration.worker_factory = lambda: FeatureWorker(HungTracker)
                runtime.start()
                try:
                    self.assertEqual(runtime.request("start").result(3)["error"], 0)
                    self.assertEqual(runtime.request("start_calibration", {"points": 1}).result(3)["error"], 0)
                    deadline = time.monotonic() + 3
                    worker = runtime.service.calibration.worker
                    while not worker.ready and time.monotonic() < deadline:
                        time.sleep(.02)
                    self.assertTrue(worker.ready)
                    response = runtime.request("start_calibration_point", {"index": 1, "attempt": 1,
                                                                           "x": .5, "y": .5}).result(.5)
                    self.assertTrue(response["point_pending"])
                    before = runtime.world.identity.source_time_s
                    time.sleep(.3)
                    self.assertGreater(runtime.world.identity.source_time_s, before)
                    self.assertEqual(runtime.request("get_device_status").result(.5)["error"], 0)
                    if cancel:
                        self.assertEqual(runtime.request("cancel_calibration").result(.5)["error"], 0)
                        self.assertFalse(worker.process.is_alive())
                        self.assertIsNone(runtime.service.calibration.card_sample)
                    else:
                        point = runtime.events.get(timeout=4)
                        if point.get('id') == 'calibration_ready':
                            point = runtime.events.get(timeout=4)
                        self.assertEqual(point["error"], -1)
                        self.assertIn("超过 2 秒", point["msg"])
                        self.assertFalse(worker.process.is_alive())
                        self.assertEqual(runtime.service.calibration.card_index, 1)
                        self.assertEqual(runtime.service.state, "ready")
                    self.assertEqual(runtime.request("stop").result(.5)["error"], 0)
                    self.assertFalse(runtime.service.calibration.verified)
                finally:
                    runtime.close()

    def test_failed_tracker_launch_ends_calibration_and_keeps_video_alive(self):
        with MockCapture() as capture:
            runtime = PupilRuntime(capture.config())
            runtime.start()
            try:
                self.assertEqual(runtime.request('start').result(3)['error'], 0)
                with patch('services.eye_tracking.adapters.pupil_core.feature_worker.subprocess.Popen',
                           side_effect=OSError('tracker launch denied')):
                    self.assertEqual(runtime.request('start_calibration', {'points': 1}).result(.5)['error'], 0)
                    result = runtime.events.get(timeout=2)
                    self.assertEqual(result['id'], 'complete_calibration')
                    self.assertEqual(result['error'], -1)
                    self.assertIn('tracker launch denied', result['msg'])
                self.assertFalse(runtime.service.calibration.pending)
                self.assertIsNone(runtime.service.calibration.worker)
                before = runtime.world.identity.source_time_s
                time.sleep(.2)
                self.assertGreater(runtime.world.identity.source_time_s, before)
                self.assertEqual(runtime.request('get_device_status').result(.5)['state'], 'ready')
            finally:
                runtime.close()

    def test_slow_process_launch_does_not_block_video_or_cancel(self):
        entered, release = threading.Event(), threading.Event()
        processes = []
        original = subprocess.Popen
        def delayed_start(*args, **kwargs):
            entered.set()
            release.wait(5)
            process = original(*args, **kwargs)
            processes.append(process)
            return process
        with MockCapture() as capture:
            runtime = PupilRuntime(capture.config())
            runtime.start()
            try:
                self.assertEqual(runtime.request('start').result(3)['error'], 0)
                with patch('services.eye_tracking.adapters.pupil_core.feature_worker.subprocess.Popen', delayed_start):
                    self.assertEqual(runtime.request('start_calibration', {'points': 1}).result(.5)['error'], 0)
                    worker = runtime.service.calibration.worker
                    self.assertTrue(entered.wait(1))
                    before = runtime.world.identity.source_time_s
                    time.sleep(.2)
                    self.assertGreater(runtime.world.identity.source_time_s, before)
                    self.assertEqual(runtime.request('cancel_calibration').result(.5)['error'], 0)
                    release.set()
                    worker._starter.join(3)
                    self.assertFalse(worker._starter.is_alive())
                    self.assertTrue(all(process.poll() is not None for process in processes))
                self.assertEqual(runtime.request('stop').result(.5)['error'], 0)
            finally:
                release.set()
                runtime.close()

    def test_software_controls_card_samples_and_waits_for_capture_result(self):
        with MockCapture(auto_calibration=True, live_clock=True) as capture:
            runtime = PupilRuntime(capture.config())
            runtime.start()
            try:
                self.assertEqual(runtime.request("start").result(3)["error"], 0)
                result = self.sample_cards(runtime, points=3)
                self.assertEqual(result["error"], 0, result)
                self.assertTrue(result["coe"].startswith("pupil-session:"))
                self.assertEqual(len(capture.calibrations), 1)
                refs = capture.calibrations[0]["ref_list"]
                self.assertEqual({round(r["norm_pos"][0], 2) for r in refs}, {.2, .8, .5})
                self.assertEqual({round(r["norm_pos"][1], 2) for r in refs}, {.75, .25})
                self.assertNotIn("C", capture.requests)
                self.assertNotIn("c", capture.requests)
                self.assertNotIn("R", capture.requests)
            finally:
                runtime.close()

    def test_recovery_scan_failure_keeps_command_worker_alive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "project.json").write_text('{"deviceModel":"PupilCore"}')
            runtime = PupilRuntime(NetworkConfig(), project_roots=[root])
            with patch('services.eye_tracking.application.pupil_runtime.recover_directory', side_effect=PermissionError('denied')):
                runtime.start()
                try:
                    self.assertEqual(runtime.request('get_recording_status').result(3)['status'], 'idle')
                    self.assertIn('denied', runtime.last_error)
                finally:
                    runtime.close()

    def test_production_entrypoint_parent_pipe_shutdown(self):
        async def scenario(capture):
            sockets = [socket.socket() for _ in range(3)]
            try:
                for reservation in sockets:
                    reservation.bind(("127.0.0.1", 0))
                ports = [reservation.getsockname()[1] for reservation in sockets]
            finally:
                for reservation in sockets:
                    reservation.close()
            executable = os.environ.get("MRT_PUPIL_EXECUTABLE")
            entry = [executable] if executable else [sys.executable, "-m", "services.eye_tracking.entrypoints.pupil_server"]
            process = subprocess.Popen([*entry,
                '--backend', 'capture',
                "--capture-port", str(capture.remote_port), "--image-port", str(ports[0]),
                "--eye-port", str(ports[1]), "--command-port", str(ports[2]), "--control-stdin", "--origin", "null"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + (20 if executable else 5)
                while True:
                    try:
                        command = await connect(f"ws://127.0.0.1:{ports[2]}", origin="null", proxy=None)
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise
                        await asyncio.sleep(0.02)
                async with command:
                    await command.send(json.dumps({"type": "req_cmd", "id": "get_device_status"}))
                    result = json.loads(await asyncio.wait_for(command.recv(), 3))
                    self.assertTrue(result["capture_connected"])
                    self.assertFalse(result["acquisition_ready"])
                    self.assertEqual(result['backend_revision'], 'pupil-free-card-v7')
                    capture.frames.set()
                    async def request(name, args=None):
                        await command.send(json.dumps({'type': 'req_cmd', 'id': name, 'args': args or {}}))
                        while True:
                            response = json.loads(await asyncio.wait_for(command.recv(), 3))
                            if response.get('id') == name:
                                return response
                    self.assertEqual((await request('start'))['error'], 0)
                    self.assertEqual((await request('start_calibration', {'points': 1}))['error'], 0)
                    deadline = time.monotonic() + 60
                    while True:
                        status = await request('get_device_status')
                        feature = status['calibration_feature']
                        self.assertIsNotNone(feature, status)
                        self.assertFalse(feature['error'], feature)
                        if feature['ready']:
                            break
                        self.assertLess(time.monotonic(), deadline, feature)
                        await asyncio.sleep(.05)
                    self.assertIsInstance(feature['pid'], int)
                    point = await request('start_calibration_point', {'index': 1, 'attempt': 1, 'x': .2, 'y': .25})
                    self.assertTrue(point['point_pending'], point)
                    # Small mock frame intentionally fails feature quality; it must respond, not stall.
                    while point.get('point_pending') or point.get('id') != 'start_calibration_point':
                        point = json.loads(await asyncio.wait_for(command.recv(), 3))
                    self.assertEqual(point['id'], 'start_calibration_point')
                    self.assertEqual(point['error'], -1)
                    self.assertEqual((await request('cancel_calibration'))['error'], 0)
                    self.assertIsNone((await request('get_device_status'))['calibration_feature'])
                    self.assertEqual((await request('stop'))['error'], 0)
                process.stdin.write("shutdown\n")
                process.stdin.flush()
                _, error = await asyncio.to_thread(process.communicate, timeout=5)
                self.assertEqual(process.returncode, 0, error)
                self.assertIn('pupil.feature bootstrap entered', error)
            finally:
                if process.poll() is None:
                    process.kill()
                    _, error = process.communicate(timeout=5)
                    if sys.exc_info()[0] is not None:
                        print(error, file=sys.stderr)
        with MockCapture(frames=False) as capture:
            asyncio.run(scenario(capture))

    def test_receipt_invalidated_on_reconnect_and_stream_failure(self):
        with MockCapture(auto_calibration=True, live_clock=True) as capture:
            runtime = PupilRuntime(capture.config())
            runtime.start()
            try:
                self.assertEqual(runtime.request("start").result(3)["error"], 0)
                result = self.sample_cards(runtime)
                self.assertEqual(result["error"], 0, result)
                token = result["coe"]
                self.assertEqual(runtime.request("stop").result(3)["error"], 0)
                self.assertEqual(runtime.request("start").result(3)["error"], 0)
                self.assertEqual(runtime.request("start_tracking", {"coe": token}).result(3)["error"], -1)
                capture.regress_clock.set()
                event = runtime.events.get(timeout=3)
                self.assertEqual(event["type"], "notify_device_error")
                self.assertFalse(runtime.request("get_device_status").result(3)["acquisition_ready"])
                self.assertFalse(runtime.service.calibration.verified)
            finally:
                runtime.close()

    def test_jpeg_normalization_and_metadata_mismatch(self):
        output = io.BytesIO()
        Image.new("RGB", (2, 2), (255, 0, 0)).save(output, "JPEG")
        parts = multipart(format="jpeg", width=2, height=2)
        parts[2] = output.getvalue()
        frame = decode_frame(decode_message(parts, max_bytes=4096), 1, 1)
        self.assertEqual(len(frame.pixels), 12)
        self.assertGreater(frame.pixels[2], 240)
        wrong = multipart(format="jpeg", width=3, height=2)
        wrong[2] = output.getvalue()
        from services.eye_tracking.adapters.pupil_core.network import PupilProtocolError
        with self.assertRaises(PupilProtocolError):
            decode_frame(decode_message(wrong, max_bytes=4096), 1, 1)

    def test_project_path_authorization(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            project = root / "project"
            project.mkdir()
            (project / "project.json").write_text('{"deviceModel":"PupilCore"}')
            paths = RecordingPaths([project])
            self.assertEqual(paths.directory(str(project)), project / "recordings")
            experiment = project / "experiments" / "exp_1"
            experiment.mkdir(parents=True)
            self.assertEqual(paths.directory(str(experiment)), experiment / "recordings")
            (project / "unrelated").mkdir()
            with self.assertRaises(PermissionError):
                paths.directory(str(project / "unrelated"))
            with self.assertRaises(PermissionError):
                paths.directory(str(root))
            with self.assertRaises(PermissionError):
                RecordingPaths([]).directory(str(project))
            (project / "project.json").write_text('{"deviceModel":"Pro"}')
            with self.assertRaises(ValueError):
                paths.directory(str(project))

    def test_capture_without_camera_is_not_ready(self):
        with MockCapture(frames=False) as capture:
            runtime = PupilRuntime(capture.config())
            runtime.service.first_frame_timeout_s = 0.15
            runtime.start()
            try:
                status = runtime.request("get_device_status").result(3)
                self.assertTrue(status["capture_connected"])
                self.assertFalse(status["acquisition_ready"])
                self.assertEqual(runtime.request("start").result(3)["error"], -1)
                self.assertEqual(runtime.request("start_recording").result(3)["error"], -1)
                self.assertEqual(runtime.request("start_calibration").result(3)["error"], -1)
                self.assertTrue(runtime.request("get_device_status").result(3)["capture_connected"])
            finally:
                runtime.close()
            self.assertTrue(set(capture.requests).issubset({"v", "SUB_PORT"}))

    def test_formal_websocket_command_preview_and_shutdown(self):
        async def scenario(capture):
            runtime = PupilRuntime(capture.config())
            server = PupilWebSocketServer(runtime, image_port=0, eye_port=0, command_port=0)
            await server.start()
            try:
                async with connect(f"ws://127.0.0.1:{server.bound_ports[2]}", proxy=None) as command:
                    await command.send(json.dumps({"type": "req_cmd", "id": "start", "args": {"sdk_model": "PupilCore"}}))
                    self.assertEqual(json.loads(await command.recv())["model"], "PupilCore")
                    async with connect(f"ws://127.0.0.1:{server.bound_ports[0]}", proxy=None) as video:
                        frame = json.loads(await asyncio.wait_for(video.recv(), 3))
                        self.assertEqual(frame["type"], "image_frame")
                        self.assertEqual(frame["source"], "PupilCore")
                    await command.send(json.dumps({"type": "req_cmd", "id": "stop"}))
                    self.assertEqual(json.loads(await command.recv())["error"], 0)
            finally:
                await server.close()
        with MockCapture() as capture:
            asyncio.run(scenario(capture))

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg and ffprobe required")
    def test_recording_commands_finalize_real_media(self):
        with tempfile.TemporaryDirectory() as temporary, MockCapture(video_size=(64, 48), auto_calibration=True, live_clock=True) as capture:
            root = Path(temporary)
            (root / "project.json").write_text('{"deviceModel":"PupilCore"}')
            experiment = root / "experiments" / "exp_1"
            experiment.mkdir(parents=True)
            runtime = PupilRuntime(capture.config(), project_roots=[root])
            runtime.start()
            try:
                self.assertEqual(runtime.request("start").result(3)["error"], 0)
                self.assertEqual(runtime.request("start_recording", {"project_path": str(experiment)}).result(3)["error"], -1)
                calibrated = self.sample_cards(runtime)
                self.assertEqual(calibrated["error"], 0, calibrated)
                self.assertNotIn("left_score", calibrated)
                self.assertEqual(runtime.request("start_tracking", {"coe": calibrated["coe"]}).result(3)["error"], 0)
                self.assertEqual(runtime.request("set_stimulus", {"name": "刺激物一"}).result(3)["error"], 0)
                # A record must carry its own angular report, independently of
                # renderer metadata finalization or later subject calibrations.
                from services.eye_tracking.adapters.pupil_core.angular_metrics import summarize_angles
                audit_at_start = runtime.service.calibration.snapshot()
                training = {"intrinsicsIndividuallyCalibrated": False, "metrics": {
                    "left": summarize_angles([0.5, 0.5]), "right": summarize_angles([1.0, 1.0])}}
                audit_at_start["result"]["params"]["training_angular"] = training
                with patch.object(runtime.service.calibration, "snapshot", return_value=audit_at_start):
                    response = runtime.request("start_recording", {"project_path": str(experiment), "subject_name": "张三", "split_screen": True}).result(12)
                self.assertEqual(response["error"], 0, response)
                self.assertRegex(response["recording_id"], r"^pupil_\w+_\d{8}_\d{6}$")
                self.assertEqual(runtime.request("set_stimulus", {"name": "刺激物二"}).result(3)["error"], 0)
                clock = runtime.request("get_source_clock").result(3)
                self.assertEqual(clock["error"], 0)
                self.assertEqual(clock["recording_id"], response["recording_id"])
                self.assertEqual(clock["source_time_origin_s"], response["source_time_origin_s"])
                self.assertGreaterEqual(clock["remote_round_trip_ms"], 0)
                self.assertEqual(Path(response["video_path"]).parent, experiment.resolve() / "recordings")
                self.assertEqual(runtime.request("start_recording", {"project_path": str(root)}).result(3)["error"], -1)
                self.assertEqual(runtime.request("add_custom_marker", {"name": "mark", "timestamp": 9999999}).result(3)["error"], 0)
                self.assertEqual(runtime.request("add_trigger_marker", {"triggerValue": 7}).result(3)["error"], 0)
                time.sleep(0.1)
                stopped = runtime.request("stop_recording").result(3)
                self.assertEqual(stopped["status"], "finalizing")
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    status = runtime.request("get_recording_status").result(3)
                    if status["status"] == "finalized":
                        break
                    time.sleep(0.05)
                self.assertEqual(status["result"]["status"], "complete", status)
                self.assertEqual(status["result"]["error"], 0)
                self.assertGreater(status["result"]["video_size"], 0)
                import msgpack
                audit_path = Path(response["csv_path"]).with_suffix(".pupil") / "calibration.msgpack"
                audit = msgpack.unpackb(audit_path.read_bytes(), raw=False)
                self.assertEqual(audit["mode"], "natural_feature")
                self.assertGreater(len(audit["ref_list"]), 10)
                self.assertFalse(audit["independentValidationPerformed"])
                self.assertGreater(status["result"]["elapsed_ms"], 0)
                self.assertTrue(Path(response["video_path"]).is_file())
                meta = json.loads(Path(response["video_path"]).with_suffix(".meta.json").read_text(encoding="utf-8"))
                self.assertEqual(meta["subjectName"], "张三")
                self.assertTrue(meta["calibrationVerified"])
                self.assertEqual(meta["calibrationTrainingAngular"], training)
                self.assertFalse(meta["independentValidationPerformed"])
                self.assertIsNone(meta["calibrationValidation"])
                self.assertEqual(audit["result"]["params"]["training_angular"], training)
                self.assertEqual(len(meta["markers"]), 2)
                self.assertLess(meta["markers"][0]["timestamp"], 10000)
                with Path(response["csv_path"]).open(encoding="utf-8") as handle:
                    rows = list(csv.DictReader(handle))
                self.assertTrue(any(row["customMarker"] == "mark" for row in rows))
                self.assertTrue(any(row["triggerMark"] == "7" for row in rows))
                self.assertTrue(any(row["stimulus"] == response["recording_id"] for row in rows))
                self.assertFalse(any(row["stimulus"] in ("刺激物一", "刺激物二") for row in rows))
                if shutil.which("node"):
                    checked = subprocess.run(["node", str(Path(__file__).with_name("check_record_list.mjs"))],
                        input=json.dumps({"projectDir": str(experiment), "recordingId": response["recording_id"]}),
                        text=True, capture_output=True, timeout=10)
                    self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
                event = runtime.events.get(timeout=1)
                self.assertEqual(event["type"], "notify_recording_finalized")
                self.assertEqual(event["recording_id"], response["recording_id"])
                self.assertEqual(event["error"], 0)
            finally:
                runtime.close()
            self.assertNotIn("R", capture.requests)
            self.assertNotIn("r", capture.requests)


if __name__ == "__main__":
    unittest.main()
