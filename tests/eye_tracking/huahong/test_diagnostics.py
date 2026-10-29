import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from services.eye_tracking.infrastructure.huahong_diagnostics import HuahongWatchdog


MODULE = 'services.eye_tracking.infrastructure.huahong_diagnostics'


class HuahongDiagnosticsTests(unittest.TestCase):
    def test_runtime_reports_blocked_read_and_processes_stop_after_read_recovers(self):
        from services.eye_tracking.application.huahong_runtime import HuahongRuntime
        entered, release, reported = threading.Event(), threading.Event(), threading.Event()
        runtime = HuahongRuntime('HH_ET28', '/unused-sdk')

        def read(_timeout):
            entered.set()
            release.wait(2)
            return []

        runtime.service = SimpleNamespace(state='ready', generation=1, sequence=7,
                                         _last_frame=time.monotonic(), queued_bytes=42,
                                         read=read, close=lambda: setattr(runtime.service, 'state', 'idle'))
        runtime._diagnostics = HuahongWatchdog('HH_ET28', runtime._diagnostic_snapshot, interval_s=.01)
        phase = runtime._diagnostics.phase
        with self.assertLogs(level='INFO') as captured, \
                patch.object(runtime._diagnostics, 'phase', side_effect=lambda name, **_: phase(name, timeout_s=.025)), \
                patch(f'{MODULE}.faulthandler.dump_traceback', side_effect=lambda **_: reported.set()):
            runtime.start()
            try:
                self.assertTrue(entered.wait(1))
                stop = runtime.request('stop')
                self.assertTrue(reported.wait(1))
                self.assertFalse(stop.done())
                release.set()
                self.assertEqual(stop.result(timeout=1)['error'], 0)
                self.assertEqual(runtime.service.state, 'idle')
            finally:
                release.set()
                runtime.close()
        warnings = [record.getMessage() for record in captured.records if record.levelname == 'WARNING']
        self.assertEqual(len(warnings), 1)
        self.assertIn('phase=service.read', warnings[0])
        self.assertIn("'queued_bytes': 42", warnings[0])
        self.assertFalse(runtime._diagnostics._thread.is_alive())

    def test_blocked_owner_reports_phase_snapshot_once_then_finishes_and_exits(self):
        entered, release, reported = threading.Event(), threading.Event(), threading.Event()
        watchdog = HuahongWatchdog('HH_ET28', lambda: {'state': 'ready', 'queued_bytes': 123}, interval_s=.01)

        def blocked_operation():
            with watchdog.phase('service.read', timeout_s=.025):
                entered.set()
                release.wait(2)

        owner = threading.Thread(target=blocked_operation)
        with self.assertLogs(MODULE, level='INFO') as captured, \
                patch(f'{MODULE}.faulthandler.dump_traceback', side_effect=lambda **_: reported.set()) as dump:
            watchdog.start()
            owner.start()
            try:
                self.assertTrue(entered.wait(1))
                self.assertTrue(reported.wait(1))
                # Repeated checks of the same hung phase must not flood the log.
                for _ in range(20):
                    watchdog._check()
            finally:
                release.set()
                owner.join(1)
                watchdog.close()
        self.assertFalse(owner.is_alive())
        self.assertFalse(watchdog._thread.is_alive())
        dump.assert_called_once_with(all_threads=True)
        warnings = [record.getMessage() for record in captured.records if record.levelname == 'WARNING']
        self.assertEqual(len(warnings), 1)
        self.assertIn('phase=service.read', warnings[0])
        self.assertIn("'queued_bytes': 123", warnings[0])
        self.assertTrue(any('phase_finished' in record.getMessage() for record in captured.records))

    def test_normal_phases_are_quiet_and_close_is_safe_before_start(self):
        watchdog = HuahongWatchdog('HH_ET28')
        with patch(f'{MODULE}.time.monotonic', return_value=1), \
                patch(f'{MODULE}._LOGGER') as logger, patch(f'{MODULE}.faulthandler.dump_traceback') as dump:
            for _ in range(100):
                with watchdog.phase('service.read', timeout_s=2):
                    watchdog._check()
            watchdog._check()
            watchdog.close()
            watchdog.close()
        logger.warning.assert_not_called()
        logger.info.assert_not_called()
        dump.assert_not_called()

    def test_nested_phases_restore_parent_and_each_reports_at_most_once(self):
        watchdog = HuahongWatchdog('HH_ET28')
        with patch(f'{MODULE}.time.monotonic', return_value=0) as clock, \
                patch(f'{MODULE}._LOGGER') as logger, patch(f'{MODULE}.faulthandler.dump_traceback') as dump:
            with watchdog.phase('command:start', timeout_s=10):
                clock.return_value = 11
                watchdog._check()
                with watchdog.phase('service.close', timeout_s=5):
                    clock.return_value = 17
                    watchdog._check()
                    watchdog._check()
                watchdog._check()
            watchdog._check()
        self.assertEqual(dump.call_count, 2)
        self.assertEqual(logger.warning.call_count, 2)
        self.assertEqual(logger.info.call_count, 2)

    def test_snapshot_and_stack_errors_do_not_replace_application_error(self):
        watchdog = HuahongWatchdog('HH_ET28', Mock(side_effect=RuntimeError('snapshot failed')))
        with patch(f'{MODULE}.time.monotonic', return_value=0) as clock, \
                patch(f'{MODULE}._LOGGER') as logger, \
                patch(f'{MODULE}.faulthandler.dump_traceback', side_effect=OSError('stderr unavailable')) as dump:
            with self.assertRaisesRegex(ValueError, 'application failure'):
                with watchdog.phase('service.close', timeout_s=5):
                    clock.return_value = 6
                    watchdog._check()
                    watchdog._check()
                    raise ValueError('application failure')
        self.assertEqual(dump.call_count, 1)
        self.assertEqual(logger.warning.call_count, 2)
        self.assertIn('snapshot failed', str(logger.warning.call_args_list[0]))
        self.assertIn('stack_dump_failed', str(logger.warning.call_args_list[1]))

    def test_finished_phase_is_not_reported_if_snapshot_interleaves_with_owner(self):
        watchdog = HuahongWatchdog('HH_ET28')
        phase = watchdog.phase('service.read', timeout_s=2)
        with patch(f'{MODULE}.time.monotonic', return_value=0) as clock, \
                patch(f'{MODULE}._LOGGER') as logger, patch(f'{MODULE}.faulthandler.dump_traceback') as dump:
            phase.__enter__()
            watchdog.snapshot = lambda: phase.__exit__(None, None, None)
            clock.return_value = 3
            watchdog._check()
        logger.warning.assert_not_called()
        dump.assert_not_called()

    def test_heartbeat_reports_active_device_at_five_seconds_and_stays_quiet_when_idle(self):
        snapshot = {'state': 'idle', 'sequence': 0}
        watchdog = HuahongWatchdog('HH_ET28', lambda: snapshot.copy())
        with patch(f'{MODULE}.time.monotonic', return_value=0) as clock, \
                patch(f'{MODULE}._LOGGER') as logger, patch(f'{MODULE}.faulthandler.dump_traceback') as dump:
            watchdog._check()
            logger.info.assert_not_called()
            snapshot.update(state='ready', sequence=30)
            with watchdog.phase('service.read', timeout_s=100):
                for value in (1, 2, 3, 4, 4.999):
                    clock.return_value = value
                    watchdog._check()
                logger.info.assert_not_called()
                for value in (5, 5.01, 6, 7, 8, 9.999):
                    clock.return_value = value
                    watchdog._check()
                self.assertEqual(logger.info.call_count, 1)
                self.assertIn('service.read', str(logger.info.call_args))
                self.assertIn('sequence', str(logger.info.call_args))
            clock.return_value = 10
            watchdog._check()
            self.assertEqual(logger.info.call_count, 2)
            snapshot['state'] = 'idle'
            clock.return_value = 15
            watchdog._check()
            self.assertEqual(logger.info.call_count, 2)
        logger.warning.assert_not_called()
        dump.assert_not_called()
