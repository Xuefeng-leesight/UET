"""Explicit child entry: direct UVC + detectors, or an isolated calibration fit."""
import logging
import faulthandler
from contextlib import redirect_stdout
import sys
import threading
import time

from ..pupil_core.feature_worker import _read_packet, _write_packet
from ...infrastructure.pupil_parent_pipe import parent_pipe_reader, wait_for_parent


def plain(value):
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [plain(v) for v in value]
    if hasattr(value, 'tolist'):
        return value.tolist()
    return value


def verified_frame_size(image, size, role, pixel_format):
    shape = tuple(getattr(image, 'shape', ()))
    expected = (size[1], size[0], 3) if pixel_format == 'bgr' else (size[1], size[0])
    if shape != expected:
        raise ValueError(f'Camera ID{role} {pixel_format} frame shape {shape} does not match '
                         f'configured intrinsics/image shape {expected}; reconnect required')
    return shape[1], shape[0]


def camera_loop(task, stop, emit):
    import cv2
    import uvc
    from .camera import FrameClock, Intrinsics, intrinsics_for, select_devices, source_clock
    role = task['role']
    devices = select_devices(uvc.device_list(), task.get('camera_uids', ()))
    device = devices[role]
    cap = None
    detector3d = None
    try:
        cap = uvc.Capture(device['uid'])
        size = (1280, 720) if role == 2 else (320, 240) if 'Cam1' in device['name'] else (192, 192)
        if size not in [tuple(v) for v in cap.frame_sizes]:
            raise ValueError(f'{device["name"]} does not support required resolution {size}')
        cap.frame_size = size
        requested = task['world_fps'] if role == 2 else task['eye_fps']
        supported = [r for r in cap.frame_rates if r <= requested]
        if not supported:
            raise ValueError(f'No supported camera rate <= {requested}')
        cap.frame_rate = max(supported)
        cap.bandwidth_factor = 2.0 if role == 2 else 1.3
        controls = {c.display_name: c for c in cap.controls}
        settings = {'Auto Focus': 0}
        if role != 2:
            settings.update({'Auto Exposure Priority': 0, 'Auto Exposure Mode': 1, 'Saturation': 0,
                             'Absolute Exposure Time': 63 if 'Cam1' in device['name'] else 32,
                             'Gamma': 100 if 'Cam1' in device['name'] else 200})
        for name, value in settings.items():
            if name in controls:
                controls[name].value = value
        spec = intrinsics_for(device['name'], size, task.get('intrinsics'))
        camera = Intrinsics(spec)
        if role != 2:
            from pupil_detectors import Detector2D
            from pye3d.detector_3d import CameraModel, Detector3D, DetectorMode
            detector2d = Detector2D()
            # Blocking model updates stay in this killable eye worker (no orphan grandchildren).
            detector3d = Detector3D(CameraModel(focal_length=camera.focal_length, resolution=size),
                                    long_term_mode=DetectorMode.blocking)
        software = sys.platform == 'win32'
        offset = 0 if software else source_clock() - uvc.get_time_monotonic()
        latency = -.07 if role == 2 else -.015
        clock = FrameClock(offset, software=software, latency=latency)
        clock_info = time.get_clock_info('perf_counter' if software else 'monotonic')
        logging.info('pupil.camera clock role=%s implementation=%s resolution_s=%s',
                     role, clock_info.implementation, clock_info.resolution)
        emit({'kind': 'ready', 'role': role, 'intrinsics': spec, 'uid': device['uid'],
              'fps': cap.frame_rate, 'clock': 'host_receipt_estimated_latency' if software else 'uvc_monotonic',
              'host_clock': clock_info.implementation, 'host_clock_resolution_s': clock_info.resolution,
              'latency_estimate_s': latency if software else 0, 'hardware_latency_measured': False})
        preview_at = 0
        while not stop.is_set():
            frame = cap.get_frame(1.0)
            stamp = clock.timestamp(frame.timestamp, source_clock())
            items = []
            if role != 2:
                gray = frame.gray
                eye_size = verified_frame_size(gray, size, role, 'gray')
            preview_due = role == 2 or stamp - preview_at >= 1 / 15
            if preview_due:
                bgr = frame.bgr
                preview_size = verified_frame_size(bgr, size, role, 'bgr')
            if role != 2:
                result2d = plain(detector2d.detect(gray))
                result2d.update(timestamp=stamp, id=role, topic=f'pupil.{role}.2d', method='2d c++',
                                eye_resolution=list(eye_size))
                result3d = plain(detector3d.update_and_detect(result2d, gray))
                result3d.update(timestamp=stamp, id=role, topic=f'pupil.{role}.3d', method='3d pye3d',
                                native_source=True, ellipse_2d=result2d['ellipse'],
                                confidence_2d=result2d['confidence'],
                                eye_resolution=list(eye_size),
                                projected_diameter_px=result3d['diameter'], diameter=result2d['diameter'])
                for result in (result2d, result3d):
                    x, y = result['location']
                    result['norm_pos'] = [x / eye_size[0], 1 - y / eye_size[1]]
                    items.append({'payload': result})
            if preview_due:
                topic = 'frame.world' if role == 2 else f'frame.eye.{role}'
                items.append({'payload': {'topic': topic, 'timestamp': stamp, 'format': 'bgr',
                                          'width': preview_size[0], 'height': preview_size[1], 'index': int(frame.index)},
                              'pixels': bgr.tobytes()})
                preview_at = stamp
            emit({'kind': 'data', 'role': role, 'items': items})
    finally:
        if cap is not None:
            cap.close()


def worker_main(kind):
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    task = _read_packet(sys.stdin.buffer)
    stop = threading.Event()
    read_parent = parent_pipe_reader(sys.stdin.buffer)
    def watch_parent():
        try:
            wait_for_parent(read_parent)
        except Exception:
            logging.exception('Native parent pipe failed')
        finally:
            stop.set()
    output = sys.stdout.buffer
    emit = lambda value: _write_packet(output, plain(value))
    monitor_started = False
    def start_monitor():
        nonlocal monitor_started
        if not monitor_started:
            threading.Thread(target=watch_parent, daemon=True).start()
            monitor_started = True
    try:
        if kind not in ('prepare', 'camera', 'fit'):
            raise ValueError('Unsupported native worker')
        # Load DLLs before starting ANY blocking parent-reader thread. Windows
        # tests showed raw ReadFile alone did not eliminate the NumPy hang.
        # During bootstrap the owning PipeWorker can still terminate/kill us.
        from .preparation import load_dependencies
        faulthandler.enable()
        faulthandler.dump_traceback_later(4, repeat=False)
        try:
            with redirect_stdout(sys.stderr):
                timings = load_dependencies()
        finally:
            faulthandler.cancel_dump_traceback_later()
        start_monitor()
        if kind == 'prepare':
            emit({'kind': 'prepared', 'import_seconds': timings})
            stop.wait()
        elif kind == 'camera':
            import cv2
            cv2.setNumThreads(1)
            with redirect_stdout(sys.stderr):
                camera_loop(task, stop, emit)
        elif kind == 'fit':
            import cv2
            cv2.setNumThreads(1)
            from .gazer import NativeGazer
            with redirect_stdout(sys.stderr):
                result = NativeGazer(task['intrinsics']).fit(task['refs'], task['pupils'])
            emit({'kind': 'fit', 'request_id': task['request_id'], 'params': result})
            stop.wait()  # Keep pipe alive until owner consumes result and closes it.
        else:
            raise ValueError('Unsupported native worker')
    except Exception as exc:
        logging.exception('Native worker failed')
        start_monitor()
        emit({'kind': 'error', 'message': str(exc)})
        stop.wait()
        return 1
    return 0
