from application.sdk_service import *  # noqa: F401,F403
from application.recording import RecordingCoordinator
from transport.protocol import parse_command_request, recording_status_response, recording_stop_response

clients_image = set()
clients_encoded_video = set()
clients_eye = set()
clients_cmd = set()
service = SDKService()
recording = RecordingCoordinator(service)


def _to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _to_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# SDK calls can block for seconds (device start, calibration, encoder
# finalization). Run them in a worker thread so all WebSocket ports keep
# serving, while keeping SDK access serialized across command clients.
_sdk_call_lock = asyncio.Lock()


async def run_sdk(func, *args, **kwargs):
    async with _sdk_call_lock:
        return await asyncio.to_thread(func, *args, **kwargs)


# Max time to wait for a single client send before dropping it as stale.
# Prevents one slow/laggy client from stalling the whole broadcast loop.
CLIENT_SEND_TIMEOUT_SEC = 5.0


async def _broadcast(queue, clients, reflect_count_attr=None):
    """Drain `queue` and fan out to every client in `clients` with a per-send
    timeout. Stale/unreachable clients are removed so a slow peer can never
    block the broadcast."""
    while True:
        data = await queue.get()
        stale = []
        for websocket in list(clients):
            try:
                await asyncio.wait_for(websocket.send(data), timeout=CLIENT_SEND_TIMEOUT_SEC)
            except (asyncio.TimeoutError, Exception):
                stale.append(websocket)
        for websocket in stale:
            try:
                clients.discard(websocket)
            except Exception:
                pass
        if reflect_count_attr is not None:
            try:
                setattr(service, reflect_count_attr, len(clients))
            except Exception:
                pass


clients_notify = set()


async def producer_images():
    await _broadcast(service.image_queue, clients_image, "image_clients")


async def producer_encoded_video():
    await _broadcast(service.encoded_video_queue, clients_encoded_video, "encoded_video_clients")


def _websocket_request_path(websocket):
    try:
        request = getattr(websocket, "request", None)
        path = getattr(request, "path", None)
        if path:
            return str(path)
    except Exception:
        pass
    try:
        path = getattr(websocket, "path", None)
        if path:
            return str(path)
    except Exception:
        pass
    return ""


async def producer_eye():
    # Broadcast to every connected eye client; previously each client ran its
    # own queue consumer, so multiple clients would steal frames from each other.
    await _broadcast(service.eye_queue, clients_eye)


async def producer_notify():
    # Single broadcast producer over the shared notify queue; previously each
    # cmd client ran its own consumer, so multiple clients stole notifications
    # from each other, and with no consumer the queue grew unbounded.
    await _broadcast(service.notify_queue, clients_notify)


async def handler_image(websocket):
    path = _websocket_request_path(websocket)
    encoded = "stream=encoded" in path or "encoded" in path
    if encoded:
        clients_encoded_video.add(websocket)
    else:
        clients_image.add(websocket)
    try:
        service.image_clients = len(clients_image)
        service.encoded_video_clients = len(clients_encoded_video)
    except Exception:
        pass
    try:
        log(
            "image client connected",
            "mode",
            "encoded" if encoded else "image",
            "clients",
            service.image_clients,
            "encoded_clients",
            service.encoded_video_clients,
        )
    except Exception:
        pass
    try:
        await websocket.wait_closed()
    finally:
        if encoded:
            try:
                clients_encoded_video.remove(websocket)
            except Exception:
                pass
        else:
            try:
                clients_image.remove(websocket)
            except Exception:
                pass
        try:
            service.image_clients = len(clients_image)
            service.encoded_video_clients = len(clients_encoded_video)
        except Exception:
            pass
        try:
            log(
                "image client disconnected",
                "mode",
                "encoded" if encoded else "image",
                "clients",
                service.image_clients,
                "encoded_clients",
                service.encoded_video_clients,
            )
        except Exception:
            pass


async def handler_eye(websocket):
    clients_eye.add(websocket)
    try:
        await websocket.wait_closed()
    finally:
        try:
            clients_eye.remove(websocket)
        except Exception:
            pass


async def handler_cmd(websocket):
    clients_cmd.add(websocket)
    clients_notify.add(websocket)
    try:
        async for message in websocket:
            log("recv", message)
            req = parse_command_request(message)
            if req is None:
                # Reply with an explicit error instead of silently dropping, so
                # malformed frames are diagnosable from the field.
                try:
                    await websocket.send(json.dumps({
                        "type": "rsp_cmd",
                        "id": "unknown",
                        "error": -1,
                        "msg": "无法解析命令（应为 JSON 且 type=req_cmd、id 非空）",
                    }, ensure_ascii=False))
                except Exception:
                    pass
                continue
            cmd_id = req["id"]
            args = req["args"]
            if cmd_id == "start":
                try:
                    requested_device_type = args.get("device_type")
                    requested_model = args.get("sdk_model")
                    requested_env = args.get("sdk_environment")
                    requested_res = args.get("sdk_resolution")
                    requested_gyro = args.get("sdk_gyroscope")
                    log(
                        "start request",
                        "requested_device_type",
                        requested_device_type,
                        "current_device_type",
                        service.device_type,
                        "current_model",
                        service.sdk_model,
                        "requested_model",
                        requested_model,
                        "sdk_environment",
                        requested_env,
                        "sdk_resolution",
                        requested_res,
                        "sdk_gyroscope",
                        requested_gyro,
                    )
                    if requested_env is not None:
                        os.environ["MRT_SDK_ENVIRONMENT"] = str(requested_env)
                    if requested_res is not None:
                        os.environ["MRT_SDK_RESOLUTION"] = str(requested_res)
                    if requested_gyro is not None:
                        os.environ["MRT_SDK_GYROSCOPE"] = str(requested_gyro)
                    ret = await run_sdk(service.ensure_started, requested_device_type, requested_model)
                    screen_size_ret = None
                    if ret == 0:
                        vw = _to_float(args.get("viewport_width"), 0)
                        vh = _to_float(args.get("viewport_height"), 0)
                        smooth = _to_int(args.get("smooth_way"), 0)
                        if service._is_glasses_mode():
                            log("start runtime tuning skipped for glasses mode")
                        else:
                            try:
                                # 桌面式设备：屏幕物理尺寸以后端 GetDeviceCaps 读取的
                                # 真实值为准（与系统缩放无关），前端 viewport 仅作兜底。
                                physical = get_physical_screen_size_mm()
                                if physical is not None:
                                    sw, sh = physical
                                    log("physical_screen_size", "source", "GetDeviceCaps", "w_mm", sw, "h_mm", sh)
                                elif vw > 0 and vh > 0:
                                    sw, sh = vw, vh
                                    log("physical_screen_size", "source", "viewport_fallback", "w_mm", sw, "h_mm", sh)
                                else:
                                    sw, sh = 0.0, 0.0
                                if sw > 0 and sh > 0:
                                    screen_size_ret = await run_sdk(service.set_screen_size, sw, sh)
                                    log("set_screen_size", sw, sh, screen_size_ret)
                                    if screen_size_ret != 0:
                                        log(
                                            "set_screen_size_warning",
                                            "model",
                                            service.sdk_model,
                                            "ret",
                                            screen_size_ret,
                                            "w_mm",
                                            sw,
                                            "h_mm",
                                            sh,
                                        )
                            except Exception as e:
                                screen_size_ret = -1
                                log("set_screen_size_exception", str(e))
                            try:
                                if smooth > 0:
                                    s = max(1, min(10, smooth))
                                    ret_sm = await run_sdk(service.set_smooth, s)
                                    log("set_smooth", s, ret_sm)
                            except Exception as e:
                                log("set_smooth_exception", str(e))
                    runtime_info = service.get_runtime_info()
                    log(
                        "start resolved runtime",
                        "device_type",
                        runtime_info.get("device_type"),
                        "model",
                        runtime_info.get("model"),
                        "record_source",
                        runtime_info.get("record_source"),
                        "sdk_root",
                        runtime_info.get("sdk_root"),
                        "types_dir",
                        runtime_info.get("types_dir"),
                        "config_ini",
                        runtime_info.get("config_ini"),
                    )
                    if ret == 0:
                        rsp_msg = "ok"
                    elif ret == -12015:
                        rsp_msg = f"start failed ({ret}) - 密钥无效或与设备不匹配，请重插加密狗后重试，并检查: {service.pwd_source}"
                    elif ret == -12:
                        rsp_msg = (
                            f"start failed ({ret}) - 加密狗实例创建失败（_7i_device_connect）。"
                            f"请重插加密狗后重试，或检查USB加密狗驱动/权限/端口，当前密码来源: {service.pwd_source}"
                        )
                    elif ret == -15:
                        rsp_msg = (
                            f"start failed ({ret}) - 密码为空。请在当前SDK配置中填写 pwd: {service.pwd_source}"
                        )
                    elif ret == -1:
                        rsp_msg = (
                            f"start failed ({ret}) - SDK启动失败。"
                            f"请检查安装路径和SDK配置目录: {runtime_info.get('sdk_root')}"
                        )
                    elif ret in (-1112, -1113):
                        rsp_msg = (
                            f"start failed ({ret}) - 相机初始化失败，找不到设备。"
                            f"请检查眼镜USB连接是否正常，或尝试重新插拔USB线"
                        )
                    elif ret in (-2111, -2112):
                        rsp_msg = (
                            f"start failed ({ret}) - 相机校验失败(PID错误)。"
                            f"请重新插拔USB线后重试，如持续出现请联系设备厂商"
                        )
                    elif ret in (-3112, -4112):
                        rsp_msg = (
                            f"start failed ({ret}) - 相机USB通信错误。"
                            f"请检查USB端口是否松动，尝试更换USB端口或数据线"
                        )
                    elif ret == -110113:
                        rsp_msg = (
                            f"start failed ({ret}) - 设备已启动但无眼图输出。"
                            f"请确认眼镜是否正确佩戴，摄像头是否被遮挡"
                        )
                    else:
                        rsp_msg = f"start failed ({ret}) - 未知错误，请检查设备连接和SDK配置"
                    rsp = {
                        "type": "rsp_cmd",
                        "id": "start",
                        "error": 0 if ret == 0 else ret,
                        "msg": rsp_msg,
                        "model": runtime_info.get("model"),
                        "device_type": runtime_info.get("device_type"),
                        "record_source": runtime_info.get("record_source"),
                        "sdk_root": runtime_info.get("sdk_root"),
                        "types_dir": runtime_info.get("types_dir"),
                        "config_ini": runtime_info.get("config_ini"),
                        "screen_size_ret": screen_size_ret,
                    }
                except Exception as e:
                    rsp = {"type": "rsp_cmd", "id": "start", "error": -1, "msg": str(e)}
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "stop":
                try:
                    ret = await run_sdk(service.stop_device)
                    rsp = {"type": "rsp_cmd", "id": "stop", "error": 0 if ret == 0 else ret, "msg": "ok" if ret == 0 else "stop failed"}
                except Exception:
                    rsp = {"type": "rsp_cmd", "id": "stop", "error": -1, "msg": "exception"}
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "set_stimulus":
                name = args.get("name", "")
                if service.device_type == "眼镜式":
                    # In glasses mode, use the recording name as the stimulus field in CSV
                    service.current_stimulus = service.current_record_name
                else:
                    service.current_stimulus = name
                rsp = {"type": "rsp_cmd", "id": "set_stimulus", "error": 0, "msg": "ok"}
                msg = json.dumps(rsp)
                # log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "start_tracking":
                coe = args.get("coe", "")
                ret = await run_sdk(service.start_tracking, coe)
                rsp = {"type": "rsp_cmd", "id": "start_tracking", "error": 0 if ret == 0 else ret, "msg": "ok" if ret == 0 else "start_tracking failed"}
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "stop_tracking":
                ret = await run_sdk(service.stop_tracking)
                rsp = {"type": "rsp_cmd", "id": "stop_tracking", "error": 0 if ret == 0 else ret, "msg": "ok" if ret == 0 else "stop_tracking failed"}
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "start_calibration":
                points = _to_int(args.get("points"), 9)
                ensure_ret = await run_sdk(service.ensure_started)
                if ensure_ret != 0:
                    rsp = {"type": "rsp_cmd", "id": "start_calibration", "error": ensure_ret, "msg": "start device failed"}
                    msg = json.dumps(rsp)
                    log("rsp", msg)
                    await websocket.send(msg)
                    continue
                ret = await run_sdk(service.start_calibration, points)
                rsp = {
                    "type": "rsp_cmd",
                    "id": "start_calibration",
                    "error": 0 if ret == 0 else ret,
                    "msg": "ok" if ret == 0 else "start_calibration failed",
                    "stop_tracking_error": service.last_calibration_stop_tracking_result,
                }
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "start_calibration_point":
                index = _to_int(args.get("index"), 1)
                x = _to_float(args.get("x"), 0.5)
                y = _to_float(args.get("y"), 0.5)
                attempt = _to_int(args.get("attempt"), 0)
                ensure_ret = await run_sdk(service.ensure_started)
                if ensure_ret != 0:
                    rsp = {"type": "rsp_cmd", "id": "start_calibration_point", "error": ensure_ret, "msg": "start device failed"}
                    msg = json.dumps(rsp)
                    log("rsp", msg)
                    await websocket.send(msg)
                    continue
                ret = await run_sdk(service.start_calibration_point, index, x, y, attempt)
                start_left, start_right = getattr(service.driver, "last_calibration_point_start_results", (ret, None))
                rsp = {
                    "type": "rsp_cmd",
                    "id": "start_calibration_point",
                    "error": 0 if ret == 0 else ret,
                    "msg": "ok" if ret == 0 else "start_calibration_point failed",
                    "attempt": attempt,
                    "left_error": start_left,
                    "right_error": start_right,
                }
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "start_recording":
                outcome = await run_sdk(recording.start, args)
                rsp = {
                    "type": "rsp_cmd",
                    "id": "start_recording",
                    "error": outcome.error,
                    "msg": outcome.message,
                    "video_path": outcome.video_path,
                    "csv_path": outcome.csv_path,
                    "recording_id": outcome.recording_id,
                }
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "stop_recording":
                stop_result, last_result = await run_sdk(recording.begin_stop)
                rsp = recording_stop_response(stop_result, last_result)
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "get_recording_status":
                snapshot = recording.status()
                rsp = recording_status_response(
                    finalizing=snapshot.finalizing,
                    recording=snapshot.recording,
                    last_result=snapshot.last_result,
                )
                msg = json.dumps(rsp, ensure_ascii=False)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "add_custom_marker":
                name = args.get("name", "")
                timestamp = _to_int(args.get("timestamp"), 0)
                marker = service.add_custom_marker(name, timestamp)
                if marker:
                    rsp = {"type": "rsp_cmd", "id": "add_custom_marker", "error": 0, "msg": "ok", "marker": marker}
                else:
                    rsp = {"type": "rsp_cmd", "id": "add_custom_marker", "error": -1, "msg": "not recording"}
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "add_trigger_marker":
                trigger_value = _to_int(args.get("triggerValue"), 0)
                timestamp = _to_int(args.get("timestamp"), 0)
                marker = service.add_trigger_marker(trigger_value, timestamp)
                if marker:
                    rsp = {"type": "rsp_cmd", "id": "add_trigger_marker", "error": 0, "msg": "ok", "marker": marker}
                else:
                    rsp = {"type": "rsp_cmd", "id": "add_trigger_marker", "error": -1, "msg": "not recording"}
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "cancel_calibration":
                cancel_ret, complete_ret = await run_sdk(service.cancel_calibration)
                error = cancel_ret if cancel_ret not in (0, None) else complete_ret
                rsp = {
                    "type": "rsp_cmd",
                    "id": "cancel_calibration",
                    "error": 0 if error in (0, None) else error,
                    "msg": "ok" if error in (0, None) else "cancel_calibration failed",
                    "cancel_error": cancel_ret,
                    "complete_sdk_error": complete_ret,
                }
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "cancel_calibration_point":
                attempt = _to_int(args.get("attempt"), 0)
                ret, cancel_left, cancel_right = await run_sdk(service.cancel_calibration_point)
                rsp = {
                    "type": "rsp_cmd",
                    "id": "cancel_calibration_point",
                    "error": 0 if ret == 0 else ret,
                    "msg": "ok" if ret == 0 else "cancel_calibration_point failed",
                    "attempt": attempt,
                    "left_error": cancel_left,
                    "right_error": cancel_right,
                }
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
            elif cmd_id == "complete_calibration":
                ensure_ret = await run_sdk(service.ensure_started)
                if ensure_ret != 0:
                    rsp = {"type": "rsp_cmd", "id": "complete_calibration", "error": ensure_ret, "msg": "start device failed"}
                    msg = json.dumps(rsp)
                    log("rsp", msg)
                    await websocket.send(msg)
                    continue
                success, coe_str, left, right = await run_sdk(service.complete_calibration)
                compute_left, compute_right = getattr(service.driver, "last_calibration_compute_results", (success, None))
                complete_sdk_error = getattr(service.driver, "last_calibration_complete_result", None)
                score_error = getattr(service.driver, "last_calibration_score_result", None)
                if service._is_glasses_mode():
                    err = success if success not in (0, None) else (
                        complete_sdk_error if complete_sdk_error not in (0, None) else 0
                    )
                else:
                    # Preserve the previously stable desktop behavior: only the
                    # calibration computation and score read must both succeed.
                    # A calibration without readable finite scores is incomplete.
                    scores_valid = math.isfinite(float(left)) and math.isfinite(float(right))
                    if success != 0:
                        err = success
                    elif score_error not in (0, None):
                        err = score_error
                    elif not scores_valid:
                        err = -1
                    else:
                        err = 0
                tracking_error = 0
                tracking_msg = "ok"
                if err == 0 and service._is_glasses_mode():
                    set_left, set_right = getattr(service.driver, "last_calibration_activation_results", (None, None))
                    if set_left != 0 or set_right != 0:
                        tracking_error = set_left if set_left not in (0, None) else set_right
                        tracking_msg = "左右眼校准数据应用失败"
                    else:
                        service.tracking_active = True
                elif err == 0 and coe_str:
                    try:
                        log("complete_calibration: start_tracking", "device_type", service.device_type, "coe_len", len(coe_str))
                        tracking_ret = await run_sdk(service.start_tracking, coe_str)
                        log("complete_calibration: start_tracking_ret", tracking_ret, "tracking_active", service.tracking_active)
                        if tracking_ret != 0:
                            tracking_error = tracking_ret
                            tracking_msg = "校准结果应用失败"
                    except Exception as tracking_ex:
                        tracking_error = -1
                        tracking_msg = f"校准结果应用异常: {tracking_ex}"
                # Applying the computed coefficients is part of calibration.
                # Do not report a partial success when either eye's set_data (or
                # the equivalent tracking activation) fails.
                if service._is_glasses_mode() and err == 0 and tracking_error not in (0, None):
                    err = tracking_error
                response_msg = "ok" if err == 0 else (
                    tracking_msg if tracking_error not in (0, None) else "complete_calibration failed"
                )
                rsp = {
                    "type": "rsp_cmd",
                    "id": "complete_calibration",
                    "error": err,
                    "msg": response_msg,
                    "coe": coe_str,
                    "left_score": left,
                    # Keep typo key for compatibility, and provide corrected key as well.
                    "right_scroe": right,
                    "right_score": right,
                    "tracking_error": tracking_error,
                    "tracking_msg": tracking_msg,
                    "compute_left_error": compute_left,
                    "compute_right_error": compute_right,
                    "complete_sdk_error": complete_sdk_error,
                    "score_error": score_error,
                }
                msg = json.dumps(rsp)
                log("rsp", msg)
                await websocket.send(msg)
    finally:
        clients_cmd.discard(websocket)
        clients_notify.discard(websocket)


async def main(image_port=9001, eye_port=9002, cmd_port=9003, host="127.0.0.1"):
    import websockets
    import signal
    
    loop = asyncio.get_running_loop()
    service.bind_loop(loop)

    async def close_servers(servers):
        for server in servers:
            try:
                server.close()
            except Exception:
                pass
        for server in servers:
            try:
                await server.wait_closed()
            except Exception:
                pass

    async def bind_servers():
        servers = []
        try:
            server_image = await websockets.serve(handler_image, host, image_port, max_size=None)
            servers.append(server_image)
            server_eye = await websockets.serve(handler_eye, host, eye_port, max_size=None)
            servers.append(server_eye)
            server_cmd = await websockets.serve(handler_cmd, host, cmd_port, max_size=None)
            servers.append(server_cmd)
            return server_image, server_eye, server_cmd
        except OSError:
            await close_servers(servers)
            raise

    server_image = server_eye = server_cmd = None
    for attempt in range(1, max(1, SERVER_BIND_RETRY_MAX) + 1):
        try:
            server_image, server_eye, server_cmd = await bind_servers()
            break
        except OSError as e:
            message = str(e)
            log(
                "server bind failed",
                "attempt=", attempt,
                "max=", SERVER_BIND_RETRY_MAX,
                "ports=", f"{image_port},{eye_port},{cmd_port}",
                "error=", message,
            )
            if attempt >= max(1, SERVER_BIND_RETRY_MAX):
                log("server bind exhausted; exiting without unhandled exception")
                return 100
            await asyncio.sleep(SERVER_BIND_RETRY_DELAY_SEC * attempt)

    if server_image is None or server_eye is None or server_cmd is None:
        log("server bind unavailable; exiting")
        return 100

    image_broadcast_task = asyncio.create_task(producer_images())
    encoded_video_broadcast_task = asyncio.create_task(producer_encoded_video())
    eye_broadcast_task = asyncio.create_task(producer_eye())
    notify_broadcast_task = asyncio.create_task(producer_notify())
    
    log(f"WebSocket servers started on {host} ports {image_port}, {eye_port}, {cmd_port}")
    
    # Create stop event
    stop_event = asyncio.Event()
    
    # Handle shutdown signals
    def signal_handler(signum, frame):
        log(f"Received signal {signum}, shutting down...")
        loop.call_soon_threadsafe(stop_event.set)
    
    # Register signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    try:
        # Wait for stop signal
        await stop_event.wait()
    finally:
        try:
            await asyncio.to_thread(service.stop_device)
        except Exception as e:
            log(f"stop_device on shutdown failed: {e}")
        log("Closing WebSocket servers...")
        image_broadcast_task.cancel()
        encoded_video_broadcast_task.cancel()
        eye_broadcast_task.cancel()
        notify_broadcast_task.cancel()
        server_image.close()
        server_eye.close()
        server_cmd.close()
        try:
            await image_broadcast_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        try:
            await encoded_video_broadcast_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        try:
            await eye_broadcast_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        try:
            await notify_broadcast_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        await server_image.wait_closed()
        await server_eye.wait_closed()
        await server_cmd.wait_closed()
        log("WebSocket servers closed")
    return 0



def cli_main():
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument("--gaze-map-job", type=str, default="")
        parser.add_argument("--image_port", type=int, default=9001)
        parser.add_argument("--eye_port", type=int, default=9002)
        parser.add_argument("--cmd_port", type=int, default=9003)
        parser.add_argument("--host", type=str, default="127.0.0.1")
        args = parser.parse_args()
    
        if args.gaze_map_job:
            from analysis.gaze_mapper import run_mapping
            try:
                job_path = Path(args.gaze_map_job).expanduser().resolve()
                mapping_job = json.loads(job_path.read_text(encoding="utf-8"))
                mapping_result = run_mapping(mapping_job)
                print(json.dumps({
                    "ok": True,
                    "outputPath": str(Path(mapping_job["outputPath"]).resolve()),
                    "summary": mapping_result["summary"],
                }, ensure_ascii=False))
                sys.exit(0)
            except Exception as mapping_error:
                print(json.dumps({"ok": False, "message": str(mapping_error)}, ensure_ascii=False), file=sys.stderr)
                sys.exit(1)
        
        try:
            exit_code = asyncio.run(main(args.image_port, args.eye_port, args.cmd_port, args.host))
            if isinstance(exit_code, int) and exit_code != 0:
                sys.exit(exit_code)
        except KeyboardInterrupt:
            log("Server stopped by user")
        except Exception as e:
            log(f"Server error: {e}")
            raise
    
