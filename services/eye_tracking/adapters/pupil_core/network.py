"""Single-owner, bounded Pupil Remote and independent video/data subscribers.

No automatic side-effecting commands, Capture recording, calibration, or clock
reset. Optional dependencies are loaded only when this adapter is opened.
"""

import math
import threading
import time
from dataclasses import dataclass
from typing import Any

from ...domain.contracts import EyeTrackingError


class PupilProtocolError(EyeTrackingError):
    pass


class PupilTimeout(EyeTrackingError):
    pass


@dataclass(frozen=True)
class NetworkConfig:
    host: str = "127.0.0.1"
    remote_port: int = 50020
    request_timeout_ms: int = 1000
    data_hwm: int = 512
    frame_hwm: int = 8
    max_message_bytes: int = 32 * 1024 * 1024

    def __post_init__(self) -> None:
        if self.host not in ("127.0.0.1", "localhost"):
            raise ValueError("First-stage integration supports localhost only")
        for name in ("remote_port", "request_timeout_ms", "data_hwm", "frame_hwm", "max_message_bytes"):
            value = getattr(self, name)
            if type(value) is not int or value <= 0:
                raise ValueError(f"{name} must be a positive integer")
        if self.remote_port > 65535:
            raise ValueError("Invalid Remote port")


@dataclass(frozen=True)
class WireMessage:
    topic: str
    payload: dict[str, Any]
    raw_parts: tuple[bytes, ...]
    received_monotonic_s: float


def decode_message(parts: list[bytes] | tuple[bytes, ...], *, max_bytes: int) -> WireMessage:
    if len(parts) < 2 or sum(map(len, parts)) > max_bytes:
        raise PupilProtocolError("Invalid multipart length or message size")
    import msgpack

    try:
        topic = parts[0].decode("utf-8", errors="strict")
        payload = msgpack.unpackb(parts[1], raw=False, strict_map_key=True)
    except (UnicodeError, ValueError, TypeError, msgpack.UnpackException) as exc:
        raise PupilProtocolError("Invalid topic or msgpack payload") from exc
    if not topic or not isinstance(payload, dict) or not all(isinstance(k, str) for k in payload):
        raise PupilProtocolError("Expected a topic and string-keyed mapping")
    if payload.get("topic", topic) != topic:
        raise PupilProtocolError("Envelope and payload topics disagree")
    return WireMessage(topic, payload, tuple(parts), time.monotonic())


class PupilNetwork:
    def __init__(self, config: NetworkConfig = NetworkConfig()) -> None:
        self.config = config
        self.version = ""
        self._owner: int | None = None
        self._context = None
        self._remote = None
        self._frames = None
        self._data = None
        self._notifications = None
        self._events = None
        self._poller = None

    def _check_owner(self) -> None:
        if self._owner != threading.get_ident():
            raise EyeTrackingError("Pupil sockets must be used and closed by their owning thread")

    def _new_remote(self) -> None:
        socket = self._context.socket(self._zmq.REQ)
        self._remote = socket
        socket.setsockopt(self._zmq.LINGER, 0)
        socket.setsockopt(self._zmq.SNDTIMEO, self.config.request_timeout_ms)
        socket.setsockopt(self._zmq.RCVTIMEO, self.config.request_timeout_ms)
        socket.setsockopt(self._zmq.MAXMSGSIZE, self.config.max_message_bytes)
        socket.connect(f"tcp://{self.config.host}:{self.config.remote_port}")

    def query(self, command: str) -> str:
        self._check_owner()
        if command not in ("v", "SUB_PORT", "t"):
            raise ValueError("Only read-only Remote queries are enabled")
        return self._request(command)

    def fit_card_calibration(self, refs, pupils) -> None:
        self.notify({"subject": "start_plugin", "name": "Gazer3D",
                     "args": {"calib_data": {"ref_list": refs, "pupil_list": pupils}}})

    def enable_pupil_detection(self) -> None:
        # Enable both eyes and both loaded detectors: Pye3D needs the 2D
        # detector's input. Do not reset an existing eye model or change ROI.
        self.notify({"subject": "pupil_detector.set_enabled", "value": True})

    def notify(self, notification) -> None:
        import msgpack

        self._check_owner()
        if self._context is None:
            raise EyeTrackingError("Pupil network is closed")
        if self._remote is None:
            self._new_remote()
        try:
            self._remote.send_multipart([("notify." + notification["subject"]).encode(), msgpack.packb(notification, use_bin_type=True)])
            reply = self._remote.recv_string()
        except self._zmq.Again as exc:
            self._remote.close(linger=0)
            self._remote = None
            raise PupilTimeout("Capture calibration notification timed out") from exc
        # Capture forwards notifications asynchronously; this ACK is not a
        # plugin-start or calibration-success result. Older API docs use the
        # second spelling, while Capture 3.5.1 replies with the first.
        if reply not in ("Message forwarded.", "Notification received"):
            raise PupilProtocolError(f"Capture rejected calibration notification: {reply}")

    def _request(self, command: str) -> str:
        self._check_owner()
        if self._context is None:
            raise EyeTrackingError("Pupil network is closed")
        if self._remote is None:
            self._new_remote()
        try:
            self._remote.send_string(command)
            return self._remote.recv_string()
        except self._zmq.Again as exc:
            # REQ cannot send again while waiting for its previous reply.
            self._remote.close(linger=0)
            self._remote = None
            raise PupilTimeout(f"Remote timed out: {command}") from exc

    def open(self) -> None:
        if self._context is not None:
            raise EyeTrackingError("Pupil network is already open")
        try:
            import zmq
            import msgpack  # noqa: F401 -- fail before acquiring any sockets
        except ImportError as exc:
            raise EyeTrackingError("Install the isolated Pupil requirements first") from exc
        self._zmq = zmq
        self._owner = threading.get_ident()
        self._context = zmq.Context()
        try:
            self.version = self.query("v").strip()
            if not self.version or len(self.version) > 200:
                raise PupilProtocolError("Invalid Capture version response")
            port_text = self.query("SUB_PORT").strip()
            if not port_text.isascii() or not port_text.isdecimal() or not 1 <= int(port_text) <= 65535:
                raise PupilProtocolError("Invalid SUB_PORT response")
            endpoint = f"tcp://{self.config.host}:{int(port_text)}"
            self._poller = zmq.Poller()
            for attr, prefixes, hwm in (
                ("_frames", (b"frame.world", b"frame.eye."), self.config.frame_hwm),
                ("_data", (b"gaze", b"pupil."), self.config.data_hwm),
                ("_notifications", (b"notify.calibration.",), 64),
                ("_events", (b"fixations", b"blinks"), self.config.data_hwm),
            ):
                socket = self._context.socket(zmq.SUB)
                setattr(self, attr, socket)
                socket.setsockopt(zmq.LINGER, 0)
                socket.setsockopt(zmq.RCVHWM, hwm)
                socket.setsockopt(zmq.MAXMSGSIZE, self.config.max_message_bytes)
                for prefix in prefixes:
                    socket.setsockopt(zmq.SUBSCRIBE, prefix)
                socket.connect(endpoint)
                self._poller.register(socket, zmq.POLLIN)
        except Exception:
            self.close()
            raise

    def receive(self, timeout_ms: int = 100) -> list[WireMessage]:
        self._check_owner()
        if type(timeout_ms) is not int or not 0 <= timeout_ms <= 1000:
            raise ValueError("Poll timeout must be 0..1000 ms")
        if self._poller is None:
            raise EyeTrackingError("Pupil network is closed")
        ready = dict(self._poller.poll(timeout_ms))
        # Eye cameras publish 2D + 3D + gaze at a much higher rate than world
        # video. One datum per turn couples their throughput to frame processing
        # and leaves calibration reading old pupils against fresh world frames.
        # Bounded nonblocking bursts preserve every received datum and leave
        # time for video, commands, cancellation and calibration deadlines.
        messages = []
        for socket, limit in ((self._notifications, 16), (self._data, 64),
                              (self._events, 16), (self._frames, 1)):
            if ready.get(socket, 0) & self._zmq.POLLIN:
                for _ in range(limit):
                    try:
                        parts = socket.recv_multipart(flags=self._zmq.NOBLOCK)
                    except self._zmq.Again:
                        break
                    messages.append(decode_message(parts, max_bytes=self.config.max_message_bytes))
        return messages

    def source_time(self) -> float:
        try:
            value = float(self.query("t"))
        except ValueError as exc:
            raise PupilProtocolError("Invalid Pupil clock response") from exc
        if not math.isfinite(value):
            raise PupilProtocolError("Non-finite Pupil clock response")
        return value

    def close(self) -> None:
        if self._context is None:
            return
        self._check_owner()
        for attr in ("_remote", "_frames", "_data", "_notifications", "_events"):
            socket = getattr(self, attr)
            if socket is not None:
                socket.close(linger=0)
                setattr(self, attr, None)
        self._context.term()
        self._context = None
        self._poller = None
        self._owner = None
