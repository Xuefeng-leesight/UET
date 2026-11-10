"""Latest-frame-only JPEG preview using MRT's existing image_frame envelope."""

import asyncio
import json
from http import HTTPStatus
from pathlib import Path
import threading

from services.eye_tracking.domain.samples import VideoFrame
from services.eye_tracking.transport.pupil_protocol import image_message


class LatestFrames:
    def __init__(self):
        self._lock = threading.Lock()
        self._frames = {}
        self.source_info = {"captureVersion": "unknown", "simulatedSource": None}

    def put(self, frame: VideoFrame) -> None:
        with self._lock:
            self._frames[frame.stream] = frame

    def take(self) -> tuple[VideoFrame, ...]:
        with self._lock:
            frames = tuple(self._frames.values())
            self._frames.clear()
            return frames


class PreviewServer:
    def __init__(self, frames: LatestFrames, *, port: int = 9101, origin: str | None = None):
        self.frames, self.port, self.origin = frames, port, origin
        self._clients = set()
        self._server = None
        self._task = None

    async def start(self) -> None:
        from websockets.asyncio.server import serve

        self._server = await serve(self._client, "127.0.0.1", self.port, process_request=self._request,
                                   compression=None, max_size=4096, max_queue=1, close_timeout=1)
        self.port = self._server.sockets[0].getsockname()[1]
        self._task = asyncio.create_task(self._publish())

    def _request(self, connection, request):
        hosts = {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}
        if request.headers.get("Host") not in hosts:
            return connection.respond(HTTPStatus.FORBIDDEN, "Invalid local host")
        if request.headers.get("Upgrade", "").lower() == "websocket":
            origins = {None, *(f"http://{host}" for host in hosts)}
            if self.origin:
                origins.add(self.origin)
            if request.headers.get("Origin") not in origins:
                return connection.respond(HTTPStatus.FORBIDDEN, "Untrusted preview origin")
            return None
        assets = {"/": ("viewer.html", "text/html; charset=utf-8"),
                  "/viewer.js": ("viewer.js", "text/javascript; charset=utf-8")}
        asset = assets.get(request.path)
        if asset is None:
            return connection.respond(HTTPStatus.NOT_FOUND, "Not found")
        response = connection.respond(HTTPStatus.OK, Path(__file__).with_name(asset[0]).read_text(encoding="utf-8"))
        del response.headers["Content-Type"]
        response.headers["Content-Type"] = asset[1]
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; "
            f"connect-src 'self' ws://127.0.0.1:{self.port} ws://localhost:{self.port}; frame-ancestors 'none'"
        )
        return response

    async def _client(self, websocket) -> None:
        if "stream=encoded" in websocket.request.path:
            await websocket.close(code=1003, reason="Pupil diagnostic preview supports image mode only")
            return
        if len(self._clients) >= 4:
            await websocket.close(code=1013, reason="Preview client limit")
            return
        pending = asyncio.Queue(maxsize=1)
        self._clients.add(pending)
        try:
            await asyncio.wait_for(websocket.send(json.dumps({"type": "pupil_diagnostic", **self.frames.source_info})), timeout=2)
            while True:
                # Bound the lifetime of disconnected idle clients even without new frames.
                try:
                    batch = await asyncio.wait_for(pending.get(), timeout=1)
                except asyncio.TimeoutError:
                    if websocket.close_code is not None:
                        return
                    continue
                for message in batch:
                    await asyncio.wait_for(websocket.send(message), timeout=2)
        except Exception:
            await websocket.close()
        finally:
            self._clients.discard(pending)

    async def _publish(self) -> None:
        while True:
            frames = self.frames.take()
            if frames and self._clients:
                messages = (json.dumps({"type": "pupil_diagnostic", **self.frames.source_info}),) + tuple(
                    [await asyncio.to_thread(image_message, frame) for frame in frames])
                for pending in tuple(self._clients):
                    if pending.full():
                        pending.get_nowait()
                    pending.put_nowait(messages)
            await asyncio.sleep(1 / 20)

    def check(self) -> None:
        if self._task is not None and self._task.done():
            self._task.result()

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
