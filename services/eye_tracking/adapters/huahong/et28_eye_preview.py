"""Bounded ET28 infrared preview, separate from lossless scene acquisition."""

import ctypes as C
from dataclasses import replace
import logging
import threading
import time

from ...domain.samples import VideoFrame


class ET28EyePreview:
    def __init__(self, width, height, identity):
        if not (0 < width <= 8192 and 0 < height <= 8192
                and width * height * 2 * 3 <= 32 * 1024 * 1024):
            raise ValueError('Invalid ET28 infrared frame dimensions')
        self.width, self.height, self.identity = width, height, identity
        self._length = width * height * 2
        self._latest = None
        self._next_delivery = 0.0
        self._active = True
        self._warned = False
        self.received_frames = 0
        self.last_frame = 0.0
        self._lock = threading.Lock()

    def callback(self, _, pointer, length):
        # The SDK owns and reuses pointer memory as soon as this callback exits.
        # Keep only the newest copied grayscale pair; never fill the recording
        # queue with preview frames or convert all native-rate frames to BGR.
        try:
            if not self._active:
                return
            if not pointer or length != self._length:
                raise ValueError('Invalid ET28 infrared frame length or pointer')
            self.received_frames += 1
            self.last_frame = time.monotonic()
            # Do not nest the service's identity lock inside the preview lock.
            # Closing or reading optional eye preview must never wait for a
            # native callback's copy or for scene acquisition's queue lock.
            latest = (self.identity('eye'), C.string_at(pointer, length))
            with self._lock:
                if not self._active:
                    return
                self._latest = latest
        except Exception as exc:
            with self._lock:
                report = not self._warned
                self._warned = True
            if report:
                logging.warning('huahong.et28 infrared_preview dropped_frame=%s', exc)

    def take(self):
        # Optional preview skips a busy slot instead of blocking the command /
        # lossless scene acquisition owner behind an SDK callback.
        if not self._lock.acquire(blocking=False):
            return []
        try:
            now = time.monotonic()
            if self._latest is None or now < self._next_delivery:
                return []
            latest, self._latest = self._latest, None
            # Runtime polls more often than its 20 Hz preview publisher. Decode
            # only at that rate, retaining the newest native frame in between.
            self._next_delivery = now + .05
        finally:
            self._lock.release()
        identity, pixels = latest
        frames = []
        # Vendor et28_interface.concat_frame and selfcheck.py identify the first
        # horizontal half as the left eye and the second as the right eye.
        # Bytes slicing needs no NumPy/OpenMP DLL import while SDK callbacks are
        # live. Interleave the gray channel using bounded C-backed slice copies.
        for offset, stream in enumerate(('left_eye', 'right_eye')):
            eye = b''.join(pixels[start:start + self.width]
                          for start in range(offset * self.width, self._length, self.width * 2))
            bgr = bytearray(self.width * self.height * 3)
            bgr[0::3] = bgr[1::3] = bgr[2::3] = eye
            frames.append(VideoFrame(replace(identity, topic=stream), stream,
                                     self.width, self.height, 'bgr', bytes(bgr), None))
        return frames

    def close(self):
        with self._lock:
            self._active = False
            self._latest = None
