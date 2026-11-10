#!/usr/bin/env python3
"""表情分析 WebSocket 服务 — 独立端口 9011/9012/9013

9011: 摄像头预览图像流
9012: 数据流（预留）
9013: 命令通道
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any

import cv2
import math
import mediapipe as mp
import websockets

try:
    # OpenCV otherwise sizes its native pool from the whole machine. In the
    # packaged app that pool competes with the glasses software video decoder.
    cv2.setNumThreads(max(1, int(os.getenv("MRT_FACIAL_OPENCV_THREADS", "1"))))
except Exception:
    pass

# 确保可以 import 同目录下的模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from application.service import analyze_video
from application.frame_inference import FrameInferenceSession
from transport.protocol import parse_command_request, parse_service_ports


# MediaPipe/GPU inference is process-global and resource intensive. Serialize
# whole-video analyses while leaving preview and status commands responsive.
analysis_lock = asyncio.Lock()
FACIAL_SERVICE_BUILD_ID = "facial-analysis-2026-09-09-v2"


# ---- 摄像头预览流 ----

class CameraPreview:
    """实时摄像头预览（MediaPipe 表情分析）"""

    def __init__(self) -> None:
        self._clients: set = set()
        self._lock: threading.Lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pending_preview_sends: dict[Any, Any] = {}

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def register_client(self, ws: Any) -> None:
        with self._lock:
            self._clients.add(ws)

    def unregister_client(self, ws: Any) -> None:
        with self._lock:
            self._clients.discard(ws)
            self._pending_preview_sends.pop(ws, None)

    def _broadcast(self, data: dict[str, Any]) -> None:
        with self._lock:
            dead: set = set()
            payload = json.dumps(data, ensure_ascii=False)
            for ws in list(self._clients):
                try:
                    if self._loop and self._loop.is_running():
                        # Preview is a latest-frame stream. Never queue an
                        # unbounded list of Base64 frames when Electron is busy
                        # rendering glasses video; skip this frame until the
                        # previous send to that client has completed.
                        previous = self._pending_preview_sends.get(ws)
                        if data.get("type") == "preview_frame" and previous is not None:
                            if not previous.done():
                                continue
                            try:
                                previous.result()
                            except Exception:
                                dead.add(ws)
                                continue
                        pending = asyncio.run_coroutine_threadsafe(ws.send(payload), self._loop)
                        if data.get("type") == "preview_frame":
                            self._pending_preview_sends[ws] = pending
                    else:
                        dead.add(ws)
                except Exception:
                    dead.add(ws)
            self._clients -= dead
            for ws in dead:
                self._pending_preview_sends.pop(ws, None)

camera_preview = CameraPreview()


frame_inference = FrameInferenceSession()
camera_catalog: list[dict[str, Any]] = []


def emit_runtime_event(event: str, **details: Any) -> None:
    payload = {"event": event, **details}
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _is_process_alive(pid: int) -> bool:
    """Cross-platform parent liveness check without sending a signal.

    ``os.kill(pid, 0)`` is a conventional Unix probe, but signal 0 isn't a
    portable liveness operation on Windows and can raise even for a live
    Electron process. Use the Win32 process API there instead.
    """
    if pid <= 0:
        return False
    if sys.platform.startswith("win"):
        try:
            import ctypes
            from ctypes import wintypes

            process_query_limited_information = 0x1000
            still_active = 259
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            kernel32.GetExitCodeProcess.restype = wintypes.BOOL
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL

            handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
            if not handle:
                return False
            try:
                exit_code = wintypes.DWORD()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    # Failure to query isn't proof that the parent is gone.
                    return True
                return exit_code.value == still_active
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            # Be conservative: never terminate the worker merely because the
            # liveness probe itself isn't supported in this Windows runtime.
            return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


# ---- WebSocket handlers ----

async def handler_image(websocket: websockets.WebSocketServerProtocol) -> None:
    """图像预览流 (端口 9011)"""
    camera_preview.register_client(websocket)
    try:
        # 保持连接，直到客户端断开
        await websocket.wait_closed()
    finally:
        camera_preview.unregister_client(websocket)


async def handler_cmd(websocket: websockets.WebSocketServerProtocol) -> None:
    """命令通道 (端口 9013)"""
    try:
        async for message in websocket:
            req = parse_command_request(message)
            if req is None:
                continue

            cmd_id = req.get("id", "")
            args: dict[str, Any] = req.get("args", {})
            rsp: dict[str, Any]
            emit_runtime_event(
                "cmd_received",
                cmdId=cmd_id,
                argKeys=sorted(args.keys()),
                hasCameraIndex="camera_index" in args,
            )

            try:
                if cmd_id == "list_cameras":
                    # Camera ownership lives exclusively in Chromium. Keeping
                    # this compatibility command non-probing guarantees Python
                    # can never enter DirectShow merely because an old client
                    # asks for a device list.
                    rsp = {"type": "rsp_cmd", "id": cmd_id, "error": 0, "msg": "renderer-owned",
                           "ok": True, "source": "renderer", "cameras": []}

                elif cmd_id == "start_preview":
                    started_at = time.perf_counter()
                    emit_runtime_event("start_preview_begin", cameraOwnedBy="renderer")
                    result = await asyncio.to_thread(frame_inference.start)
                    emit_runtime_event(
                        "start_preview_result",
                        ok=bool(result.get("ok")),
                        state=result.get("state"),
                        running=result.get("running"),
                        inferenceReady=result.get("inferenceReady"),
                        lastError=result.get("lastError"),
                        message=result.get("message", result.get("status", "ok")),
                        elapsedMs=round((time.perf_counter() - started_at) * 1000, 1),
                    )
                    rsp = {"type": "rsp_cmd", "id": cmd_id, "error": 0 if result.get("ok") else -1,
                           "msg": result.get("message", result.get("status", "ok")), **result}

                elif cmd_id == "stop_preview":
                    result = await asyncio.to_thread(frame_inference.stop)
                    rsp = {"type": "rsp_cmd", "id": cmd_id, "error": 0 if result.get("ok") else -1,
                           "msg": result.get("message", "ok"), **result}

                elif cmd_id == "infer_frame":
                    data_url = str(args.get("data_url", ""))
                    if not data_url:
                        result = {"ok": False, "message": "缺少表情帧"}
                    else:
                        result = await asyncio.to_thread(
                            frame_inference.infer_data_url,
                            data_url,
                            float(args.get("captured_at_ms", 0.0)),
                            int(args.get("sequence", 0)),
                        )
                    rsp = {"type": "rsp_cmd", "id": cmd_id, "error": 0 if result.get("ok") else -1,
                           "msg": result.get("message", "ok"), **result}

                elif cmd_id == "start_capture":
                    rsp = {"type": "rsp_cmd", "id": cmd_id, "error": -1,
                           "msg": "表情视频已改由 Chromium MediaRecorder 采集，Python 不再打开摄像头"}

                elif cmd_id == "stop_capture":
                    rsp = {"type": "rsp_cmd", "id": cmd_id, "error": 0, "msg": "renderer-owned", "ok": True}

                elif cmd_id == "get_capture_status":
                    status = frame_inference.status()
                    rsp = {"type": "rsp_cmd", "id": cmd_id, "error": 0, "msg": "ok", **status}

                elif cmd_id == "finalize_renderer_capture":
                    samples_path = Path(str(args.get("samples", "")))
                    video_path = Path(str(args.get("video", "")))
                    record_id = str(args.get("record_id", ""))
                    if not record_id or str(samples_path) == "." or str(video_path) == ".":
                        result = {"ok": False, "message": "缺少浏览器录制收尾参数"}
                    elif not video_path.is_file():
                        result = {"ok": False, "message": "表情视频尚未完成保存"}
                    else:
                        # Compatibility command for older renderer builds.
                        # Capture finalization must never materialize an
                        # analysis/result.json; explicit run_analysis is the
                        # only operation that changes a record to “已分析”.
                        result = {
                            "ok": True,
                            "message": "capture-finalized",
                            "recordId": record_id,
                            "samplesAvailable": samples_path.is_file(),
                        }
                    rsp = {"type": "rsp_cmd", "id": cmd_id, "error": 0 if result.get("ok") else -1,
                           "msg": result.get("message", "ok"), **result}

                elif cmd_id == "run_analysis":
                    video = Path(args.get("video", ""))
                    output = Path(args.get("output", ""))
                    record_id = str(args.get("record_id", ""))
                    if not str(video) or str(video) == ".":
                        rsp = {"type": "rsp_cmd", "id": cmd_id, "error": -1, "msg": "缺少视频路径"}
                    elif not record_id:
                        rsp = {"type": "rsp_cmd", "id": cmd_id, "error": -1, "msg": "缺少记录ID"}
                    else:
                        # Whole-video inference takes minutes; keep it off the
                        # event loop so other connections stay responsive.
                        async with analysis_lock:
                            result = await asyncio.to_thread(analyze_video, video, output, record_id)
                        rsp = {"type": "rsp_cmd", "id": cmd_id, "error": 0 if result.get("ok") else -1,
                               "msg": result.get("message", "ok"), **result}

                else:
                    rsp = {"type": "rsp_cmd", "id": cmd_id, "error": -1, "msg": f"未知命令: {cmd_id}"}

            except Exception as e:
                emit_runtime_event("cmd_exception", cmdId=cmd_id, error=str(e))
                rsp = {"type": "rsp_cmd", "id": cmd_id, "error": -1, "msg": str(e)}

            emit_runtime_event(
                "cmd_response_sent",
                cmdId=cmd_id,
                error=rsp.get("error"),
                msg=rsp.get("msg"),
            )
            await websocket.send(json.dumps(rsp, ensure_ascii=False))

    except websockets.exceptions.ConnectionClosed:
        pass


async def main(image_port: int = 9011, data_port: int = 9012, cmd_port: int = 9013, host: str = "127.0.0.1") -> None:
    runtime_info = {
        "buildId": FACIAL_SERVICE_BUILD_ID,
        "pid": os.getpid(),
        "python": sys.version.split()[0],
        "opencv": getattr(cv2, "__version__", "unknown"),
        "mediapipe": getattr(mp, "__version__", "unknown"),
    }
    runtime_info_path_text = os.environ.get("MRT_FACIAL_RUNTIME_INFO_PATH", "").strip()
    if runtime_info_path_text:
        runtime_info_path = Path(runtime_info_path_text)
        runtime_info_path.parent.mkdir(parents=True, exist_ok=True)
        staged_runtime_info_path = runtime_info_path.with_suffix(runtime_info_path.suffix + ".tmp")
        staged_runtime_info_path.write_text(
            json.dumps(runtime_info, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(staged_runtime_info_path, runtime_info_path)
    print(f"[facial-ws] starting on host={host} ports image={image_port} data={data_port} cmd={cmd_port}", flush=True)
    print(json.dumps({
        "event": "facial-runtime",
        **runtime_info,
        "processing": {"cameraOwnedBy": "renderer", "inferenceMode": "uploaded-frame"},
    }, ensure_ascii=False), flush=True)

    camera_preview.set_loop(asyncio.get_event_loop())

    server_image = await websockets.serve(handler_image, host, image_port)
    server_cmd = await websockets.serve(handler_cmd, host, cmd_port)
    print(f"[facial-ws] image server on {host}:{image_port}, cmd server on {host}:{cmd_port}", flush=True)

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(shutdown_signal, stop_event.set)
        except (NotImplementedError, RuntimeError):
            # Windows event loops don't support POSIX-style signal handlers.
            pass

    async def watch_parent() -> None:
        parent_pid_text = os.environ.get("MRT_FACIAL_PARENT_PID", "").strip()
        if not parent_pid_text:
            return
        try:
            parent_pid = int(parent_pid_text)
        except ValueError:
            print(f"[facial-ws] ignoring invalid parent PID: {parent_pid_text}", file=sys.stderr)
            return
        while not stop_event.is_set():
            await asyncio.sleep(2.0)
            if not _is_process_alive(parent_pid):
                print(f"[facial-ws] parent process {parent_pid} is gone; shutting down")
                stop_event.set()
                return

    parent_watch_task = asyncio.create_task(watch_parent(), name="facial-parent-watch")
    try:
        await stop_event.wait()
    finally:
        parent_watch_task.cancel()
        server_cmd.close()
        server_image.close()
        await server_cmd.wait_closed()
        await server_image.wait_closed()
        await asyncio.to_thread(frame_inference.stop)
        try:
            await parent_watch_task
        except asyncio.CancelledError:
            pass
        print("[facial-ws] shutdown complete")


if __name__ == "__main__":
    ports = parse_service_ports(sys.argv[1:])
    asyncio.run(main(ports.image, ports.data, ports.command))
