"""Rendezvous for the skills service: how a CLI call finds the daemon that
serves a given root.

One daemon per root (a daemon serves a root), so the file is named by a hash of
the resolved root path — two spellings of the same directory land on one file:

    <discovery_dir>/s-<sha256(root)[:32]>.json
    {"version": 1, "root": str, "port": int, "pid": int, "started": iso8601}

Default directory: %LOCALAPPDATA%/clutch-skills, falling back to
~/.clutch-skills on POSIX; tests and parallel checkouts repoint it with
CLUTCH_SKILLS_DISCOVERY_DIR.

No token, deliberately: this service reads nothing outside the root it was
pointed at and its one mutation is re-pointing itself, so a loopback caller has
nothing to be kept away from — unlike the workspace daemon, whose token guards
writes into a user's files. Daemons idle out, so a stale file is routine: a read
that finds a dead pid removes the file and returns None.

Stdlib only — the zero-dependency promise holds.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

VERSION = 1
_ENV_DISCOVERY_DIR = "CLUTCH_SKILLS_DISCOVERY_DIR"


def discovery_dir() -> Path:
    """Where discovery files live (overridable for tests / parallel checkouts)."""
    override = os.environ.get(_ENV_DISCOVERY_DIR)
    if override:
        return Path(override)
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "clutch-skills"
    return Path.home() / ".clutch-skills"


def root_key(root: str) -> str:
    """32 hex chars identifying the root, stable across path spellings."""
    normalized = os.path.normcase(str(Path(root).resolve()))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]


def discovery_file(root: str) -> Path:
    return discovery_dir() / f"s-{root_key(root)}.json"


def write(root: str, port: int) -> Path:
    """Atomically publish the daemon's coordinates; returns the file written."""
    payload = {
        "version": VERSION,
        "root": str(Path(root).resolve()),
        "port": int(port),
        "pid": os.getpid(),
        "started": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    final = discovery_file(root)
    final.parent.mkdir(parents=True, exist_ok=True)
    # write-then-replace: a client probing mid-write must never parse a half file
    fd, tmp_name = tempfile.mkstemp(dir=str(final.parent), prefix=final.name, suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh)
        os.replace(tmp, final)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return final


def read(root: str) -> dict | None:
    """The daemon record for this root, or None (with stale-file cleanup) when it
    is missing, corrupt, or its daemon's pid is dead."""
    path = discovery_file(root)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        path.unlink(missing_ok=True)
        return None
    if not _wellformed(payload) or not pid_alive(payload["pid"]):
        path.unlink(missing_ok=True)
        return None
    return payload


def remove(root: str) -> None:
    discovery_file(root).unlink(missing_ok=True)


def _wellformed(payload: object) -> bool:
    """Just enough shape to be usable: anything else is a stale file, never an
    error — a client must not die on someone else's junk."""
    if not isinstance(payload, dict) or payload.get("version") != VERSION:
        return False
    port, pid = payload.get("port"), payload.get("pid")
    return isinstance(port, int) and 0 < port <= 65535 and isinstance(pid, int) and pid > 0


def pid_alive(pid: int) -> bool:
    """Liveness of a daemon pid. POSIX: signal 0 probes without delivering.
    Windows: os.kill(pid, 0) would TERMINATE the process (it maps to
    TerminateProcess), so query the kernel instead via ctypes."""
    if pid <= 0:
        return False
    if os.name == "nt":
        return _pid_alive_windows(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # exists but belongs to someone else
        return True
    except OSError:
        return False
    return True


def _pid_alive_windows(pid: int) -> bool:
    import ctypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:  # ERROR_INVALID_PARAMETER etc. — no such process
        return False
    exit_code = ctypes.c_ulong()
    try:
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
    finally:
        kernel32.CloseHandle(handle)
    return exit_code.value == STILL_ACTIVE
