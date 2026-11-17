"""Working files of Pupil/Huahong recordings, kept outside the project.

The recorder needs spools, a frame map, a lease and journals while it records
and while an interrupted recording is recovered. Like the 7invensun recorder,
the project's recordings directory only receives the finished files
(<name>.csv / .mp4 / .meta.json); these working files live under the user's
local application data and are removed once the recording is saved.
"""

import hashlib
import logging
import os
from pathlib import Path
import shutil
import tempfile
import time

SIDECAR_SUFFIX = ".pupil"
# Interrupted recordings are recovered the next time their project opens.
# Anything older than this was never reopened and only holds disk space.
STALE_AFTER_S = 7 * 24 * 3600


def workspace_root():
    base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
    # resolve(): the communication journal check in Electron compares real paths.
    return (Path(base) / "HRT" / "recording-work").resolve()


def workspace_for(recordings_dir):
    """One folder per recordings directory, so recovery finds its own sessions."""
    key = os.path.normcase(str(Path(recordings_dir).resolve()))
    return workspace_root() / hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def sidecar_for(recordings_dir, name):
    return workspace_for(recordings_dir) / f"{name}{SIDECAR_SUFFIX}"


def remove_sidecar(sidecar):
    """Best effort: a leftover folder must never fail a saved recording."""
    sidecar = Path(sidecar)
    try:
        if sidecar.is_symlink() or not sidecar.is_dir() or workspace_root() not in sidecar.resolve().parents:
            return
        shutil.rmtree(sidecar, ignore_errors=True)
        parent = sidecar.parent
        if parent != workspace_root() and not any(parent.iterdir()):
            parent.rmdir()
    except OSError as exc:
        logging.warning("recording.workspace_cleanup_failed path=%s error=%s", sidecar, exc)


def sweep_stale(now=None):
    """Remove working folders of recordings nobody recovered within a week."""
    root = workspace_root()
    if not root.is_dir():
        return
    now = time.time() if now is None else now
    for project in root.iterdir():
        if project.is_symlink() or not project.is_dir():
            continue
        for sidecar in project.glob(f"*{SIDECAR_SUFFIX}"):
            try:
                if now - sidecar.stat().st_mtime < STALE_AFTER_S:
                    continue
                # A held lease means a recorder still owns it.
                from .pupil_recovery import RecordingLease
                lease = RecordingLease(sidecar)
            except (OSError, ValueError):
                continue
            lease.close()
            remove_sidecar(sidecar)
        try:
            if not any(project.iterdir()):
                project.rmdir()
        except OSError:
            pass
