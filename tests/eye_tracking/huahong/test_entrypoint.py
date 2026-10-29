import unittest
from unittest.mock import AsyncMock, Mock, patch

from services.eye_tracking.entrypoints import huahong_server


class EntrypointTests(unittest.TestCase):
    def test_diagnostics_enabled_before_sdk_runtime_for_packaged_launch(self):
        stdout, stderr = Mock(), Mock()
        with patch.object(huahong_server.sys, 'stdout', stdout), \
                patch.object(huahong_server.sys, 'stderr', stderr), \
                patch.object(huahong_server.faulthandler, 'enable') as enable_faults, \
                patch.object(huahong_server.logging, 'basicConfig'), \
                patch.object(huahong_server, 'run', new_callable=AsyncMock) as run:
            async def verify(_args):
                enable_faults.assert_called_once_with(all_threads=True)
                for stream in (stdout, stderr):
                    stream.reconfigure.assert_called_once_with(line_buffering=True, write_through=True)
            run.side_effect = verify
            self.assertEqual(huahong_server.main(['--model', 'HH_ET28', '--sdk-root', '.']), 0)
            run.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
