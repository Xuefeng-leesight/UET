"""Single-thread acquisition service, deliberately disconnected from legacy SDKService."""

import math
import time
from collections import Counter, OrderedDict

from ...domain.capabilities import DeviceCapabilities
from ...domain.contracts import EyeSample, EyeTrackingError
from .calibration import PupilCalibration
from .data_normalizer import DataNormalizer
from .frame_receiver import decode_frame
from .network import NetworkConfig, PupilNetwork, PupilProtocolError, PupilTimeout, WireMessage


class PupilService:
    capabilities = DeviceCapabilities("PupilCore", ("scene", "right_eye", "left_eye"), ("bgr",),
                                      True, True, ("capture",), ("px", "mm"))

    def __init__(self, config: NetworkConfig = NetworkConfig(), *, first_frame_timeout_s: float = 5,
                 frame_timeout_s: float = 3, confidence_threshold: float = 0.6, source=None) -> None:
        if any(not math.isfinite(v) or v <= 0 for v in (first_frame_timeout_s, frame_timeout_s)):
            raise ValueError("Frame timeouts must be finite and positive")
        self.network = source if source is not None else PupilNetwork(config)
        self.normalizer = DataNormalizer(confidence_threshold)
        self.calibration = PupilCalibration(self.network, resume_timeout_s=frame_timeout_s)
        self.first_frame_timeout_s = first_frame_timeout_s
        self.frame_timeout_s = frame_timeout_s
        self.generation = 0
        self.state = "disconnected"
        self.last_error = ""
        self.received = Counter()
        self.sequence = 0
        self._last_world_received = None
        self._frame_times = {}
        self._eye_frame_sizes = OrderedDict()
        self._world_resolution = None
        self._world_resolution_epoch = 0
        self._pending: list[EyeSample] = []
        self.last_messages: tuple[WireMessage, ...] = ()

    def connect(self) -> None:
        self.begin_connect()
        while self.state == 'connecting':
            self.poll_connect(50)

    def begin_connect(self) -> None:
        if self.state not in ("disconnected", "failed"):
            raise EyeTrackingError("Close the current Pupil session before connecting again")
        self.generation += 1
        self.state = "connecting"
        self.last_error = ""
        self.received.clear()
        self.sequence = 0
        self._last_world_received = None
        self._frame_times.clear()
        self._eye_frame_sizes.clear()
        self._world_resolution = None
        self._world_resolution_epoch = 0
        self._pending.clear()
        self.last_messages = ()
        try:
            self.network.open()
            self._connect_deadline = time.monotonic() + self.first_frame_timeout_s
        except Exception as exc:
            self._fail(exc)
            raise

    def poll_connect(self, timeout_ms=10):
        if self.state != 'connecting':
            return
        try:
            samples = self._receive(timeout_ms)
            if self._last_world_received is not None and getattr(self.network, 'ready', True):
                self._pending = samples
                self.state = 'ready'
            elif time.monotonic() >= self._connect_deadline:
                raise PupilTimeout('Camera initialization timed out; check USB, driver and source video')
        except Exception as exc:
            self._fail(exc)
            raise

    def _receive(self, timeout_ms: int) -> list[EyeSample]:
        self.last_messages = tuple(self.network.receive(timeout_ms))
        decoded_frames = {}
        # Validate the batch's real frames first, so a pupil datum preceding
        # its same-timestamp frame can still use the exact source dimensions.
        for offset, message in enumerate(self.last_messages, 1):
            if not message.topic.startswith('frame.'):
                continue
            sample = decode_frame(message, self.generation, self.sequence + offset)
            previous = self._frame_times.get(sample.stream)
            if previous is not None and sample.identity.source_time_s <= previous:
                raise PupilProtocolError('Frame clock regressed or repeated; explicit reconnect required')
            self._frame_times[sample.stream] = sample.identity.source_time_s
            if sample.stream == 'scene':
                self._last_world_received = sample.identity.received_monotonic_s
            else:
                eye = 0 if sample.stream == 'right_eye' else 1
                self._eye_frame_sizes[(eye, sample.identity.source_time_s)] = (sample.width, sample.height)
                if len(self._eye_frame_sizes) > 256:
                    self._eye_frame_sizes.popitem(last=False)
            decoded_frames[offset] = sample
        if self._world_resolution is None:
            # The first validated scene frame establishes dimensions even when
            # data messages precede it in this batch. Later changes apply in
            # receive order and break motion continuity, including A -> B -> A.
            first_scene = next((frame for frame in decoded_frames.values() if frame.stream == 'scene'), None)
            if first_scene is not None:
                self._world_resolution = (first_scene.width, first_scene.height)
        samples = []
        for offset, message in enumerate(self.last_messages, 1):
            self.sequence += 1
            if message.topic.startswith("notify.calibration."):
                continue
            if message.topic.startswith("frame."):
                sample = decoded_frames[offset]
                if sample.stream == 'scene' and self._world_resolution != (sample.width, sample.height):
                    self._world_resolution = (sample.width, sample.height)
                    self._world_resolution_epoch += 1
            else:
                if len(message.raw_parts) != 2:
                    raise PupilProtocolError("Unexpected binary attachment on gaze/pupil")
                sample = self.normalizer.normalize(message, self.generation, self.sequence,
                                                   eye_frame_sizes=self._eye_frame_sizes,
                                                   world_frame_size=self._world_resolution,
                                                   world_frame_epoch=self._world_resolution_epoch)
            self.received[message.topic] += 1
            samples.append(sample)
        return samples

    def read(self, timeout_ms: int = 100) -> list[EyeSample]:
        if self.state != "ready":
            raise EyeTrackingError("Pupil acquisition is not ready")
        # An incorrect caller must not mutate state or close another thread's sockets.
        self.network._check_owner()
        if type(timeout_ms) is not int or not 0 <= timeout_ms <= 1000:
            raise ValueError("Poll timeout must be 0..1000 ms")
        try:
            if self._pending:
                samples, self._pending = self._pending, []
            else:
                samples = self._receive(timeout_ms)
            # Drain an already queued frame before deciding that the camera stopped.
            # Capture's Gazer3D fitting can pause world publication. Only this
            # connection's bounded fit/resume phase suspends the normal watchdog.
            fitting = self.calibration.pending and self.calibration.finishing
            if (time.monotonic() - self._last_world_received > self.frame_timeout_s and
                    not (fitting and time.monotonic() < self.calibration.deadline)):
                raise PupilTimeout("World video interrupted; explicit reconnect required")
            return samples
        except Exception as exc:
            self._fail(exc)
            raise

    def _fail(self, error: Exception) -> None:
        self.calibration.reset()
        self.state = "failed"
        self.last_error = str(error)
        self._pending.clear()
        self.last_messages = ()
        self.network.close()

    def close(self) -> None:
        self.calibration.reset()
        self.network.close()
        self._pending.clear()
        self.last_messages = ()
        self.state = "disconnected"
