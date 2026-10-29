"""Load native libraries without opening USB devices or blocking commands."""
import time
import importlib
import logging


class NativePreparation:
    def __init__(self, worker_factory):
        self.worker = None
        self.ready = False
        self.error = ''
        self.deadline = time.monotonic() + 180
        try:
            self.worker = worker_factory('prepare', {})
        except Exception as exc:
            self.error = str(exc)

    def poll(self):
        if self.worker is None:
            return
        for packet in self.worker.poll():
            if packet.get('kind') == 'prepared':
                self.ready = True
                self.close()
                return
            if packet.get('kind') == 'error':
                self.error = packet.get('message') or 'Native library initialization failed'
        self.error = self.error or self.worker.error
        if not self.error and time.monotonic() >= self.deadline:
            self.error = 'Pupil 内置算法初始化超时，请检查安装依赖并重启后端'
        if self.error:
            self.close()

    def close(self):
        if self.worker is not None:
            self.worker.close()
            self.worker = None


def load_dependencies():
    # Imports only: never enumerate or open a camera during backend preparation.
    timings = {}
    for module in ('numpy', 'cv2', 'scipy.optimize', 'scipy.sparse', 'uvc', 'pupil_detectors', 'pye3d.detector_3d'):
        started = time.perf_counter()
        logging.info('pupil.prepare loading module=%s', module)
        imported = importlib.import_module(module)
        timings[module] = time.perf_counter() - started
        logging.info('pupil.prepare module=%s elapsed_s=%.4f', module, timings[module])
        if module == 'cv2':
            imported.setNumThreads(1)
    return timings
