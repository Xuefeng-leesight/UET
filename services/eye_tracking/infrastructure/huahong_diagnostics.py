"""Observe a stalled acquisition owner without taking its locks or calling the SDK."""
from contextlib import contextmanager
from dataclasses import dataclass
import faulthandler
import logging
import threading
import time


_LOGGER = logging.getLogger(__name__)


@dataclass
class _Phase:
    name: str
    started: float
    timeout_s: float
    thread_id: int
    reported: bool = False


class HuahongWatchdog:
    """Report each slow phase once; diagnostic failures never alter acquisition.

    The owner publishes a phase reference atomically. The snapshot callback must
    only read scalar fields: it must not acquire owner/SDK locks or perform I/O.
    This observer can diagnose a Python lock wait or a native call that releases
    the GIL; it cannot run while native code holds the GIL indefinitely.
    """

    def __init__(self, model, snapshot=None, *, interval_s=1.0):
        if interval_s <= 0:
            raise ValueError('Watchdog interval must be positive')
        self.model, self.snapshot, self.interval_s = model, snapshot, interval_s
        self._active = None
        self._next_heartbeat = 0.0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name='huahong-watchdog', daemon=True)

    def start(self):
        self._thread.start()

    def close(self):
        self._stop.set()
        if self._thread.ident is not None and self._thread is not threading.current_thread():
            self._thread.join(max(1.0, self.interval_s * 2))

    @contextmanager
    def phase(self, name, *, timeout_s):
        current = _Phase(name, time.monotonic(), timeout_s, threading.get_ident())
        previous, self._active = self._active, current
        try:
            yield
        finally:
            self._active = previous
            if current.reported:
                try:
                    _LOGGER.info('huahong.watchdog phase_finished model=%s phase=%s elapsed_s=%.3f',
                                 self.model, current.name, time.monotonic() - current.started)
                except Exception:
                    pass  # Diagnostics must not replace an application exception.

    def _run(self):
        while not self._stop.wait(self.interval_s):
            try:
                self._check()
            except Exception:
                pass  # A broken log handler must not terminate the observer.

    def _check(self):
        phase = self._active
        now = time.monotonic()
        elapsed = now - phase.started if phase else 0.0
        stalled = phase is not None and not phase.reported and elapsed >= phase.timeout_s
        heartbeat_due = now >= self._next_heartbeat
        if not stalled and not heartbeat_due:
            return
        try:
            snapshot = self.snapshot() if self.snapshot else {}
            if not isinstance(snapshot, dict):
                raise TypeError('Watchdog snapshot must be a dictionary of scalar fields')
        except Exception as exc:
            snapshot = {'snapshot_error': str(exc)}
        if self._stop.is_set():
            return
        if heartbeat_due:
            self._next_heartbeat = now + 5.0
            if snapshot.get('state') in ('connecting', 'ready', 'closing', 'failed'):
                _LOGGER.info('huahong.watchdog heartbeat model=%s phase=%s elapsed_s=%.3f snapshot=%s',
                             self.model, phase.name if phase else 'idle', elapsed, snapshot)
        if not stalled or self._active is not phase:
            return
        phase.reported = True
        _LOGGER.warning('huahong.watchdog stalled model=%s phase=%s elapsed_s=%.3f '
                        'timeout_s=%.3f owner_thread=%s snapshot=%s',
                        self.model, phase.name, elapsed, phase.timeout_s, phase.thread_id, snapshot)
        try:
            # stderr is captured by the existing eye-server process diagnostics.
            faulthandler.dump_traceback(all_threads=True)
        except Exception as exc:
            _LOGGER.warning('huahong.watchdog stack_dump_failed model=%s error=%s', self.model, exc)
