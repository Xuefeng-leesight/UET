"""Legacy 7invensun process entry point."""

import sys
from pathlib import Path

# The legacy runtime intentionally uses eye-tracking-root imports. A source
# script now starts in entrypoints/, while the frozen bundle retains its
# existing top-level module layout and PyInstaller import paths.
if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# The packaged binary doubles as an offline analysis CLI. Dispatch before
# importing transport/SDKService so analysis needs no DLL, device or ports.
if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--gaze-map-job":
    from analysis.gaze_mapper import main as mapping_main
    raise SystemExit(mapping_main(["--job", sys.argv[2]]))

from transport.server_runtime import cli_main


if __name__ == "__main__":
    cli_main()
