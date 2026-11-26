"""Workspace directory + path safety.

The agent works in the project's directory (the folder containing its .clc file).
Paths are resolved then checked to stay inside the workspace root; permission
rules guard risky actions. Certain files (the project's own .clc) are protected:
the agent cannot read, write, or even list them.

Workspace is the base class: it owns root/path-safety/transport and lets
subclasses define how files are actually touched. LocalWorkspace uses Path
operations.

What it carries is the HOST's own bookkeeping, not the file tools: the .clc
project file (byte offsets, the fixed-width memory index line), the per-file
snapshot the UI's undo restores, the lazy indexed log reads, the transport every
statement runs through, and the entries browsing.py walks into the UI's tree.

`list` and `grep` are here because the host's own bookkeeping needs them (the
project's memory index, the tree the UI browses) — they are not tools: the four
file tools are the workspace component's, and a root this host cannot run that
component on has no file tools at all (agent/tools/registry.py).
"""

from __future__ import annotations

import fnmatch
import os
import posixpath
import re
import tempfile
import threading
from abc import ABC, abstractmethod
from pathlib import Path, PurePath

from .localshell import LocalShell, local_shell
from .transport import CommandResult, LocalTransport, Transport

# Scratch dirs that are harmless to write to (test logs, /dev/null redirects).
# POSIX spellings; see Workspace._scratch_dirs for how they are flavored per
# host kind (a Windows LOCAL host has no /tmp; a POSIX host is the scratch side).
POSIX_SCRATCH_DIRS = ("/tmp", "/var/tmp", "/dev")


def posix_scratch_tail(token: str) -> str | None:
    """The part of a POSIX-shell path token below a scratch dir ("" for a scratch
    dir itself), or None when the token is not in the scratch surface at all.

    Lexical, and normalized exactly like the POSIX verdict (posixpath), so a
    ``..`` that climbs back OUT of the scratch dir yields None and stays the
    escape it is on Linux — the caller then judges the token in host flavor.
    """
    norm = posixpath.normpath(token)
    for scratch in POSIX_SCRATCH_DIRS:
        if norm == scratch:
            return ""
        if norm.startswith(scratch + "/"):
            return norm[len(scratch) + 1:]
    return None


def _is_relative_to(p: PurePath, other: PurePath) -> bool:
    """``PurePath.is_relative_to`` without its 3.9 floor.

    That method IS this try/``relative_to`` (3.8 already has ``relative_to``),
    so the verdict is the same and cannot drift. Named separately so the two
    guards that must agree (``Workspace.resolve`` and ``escape_path``) both go
    through one definition.
    """
    try:
        p.relative_to(other)
    except ValueError:
        return False
    return True


def _inside_or_scratch(p: PurePath, root: PurePath, scratches: tuple[PurePath, ...]) -> bool:
    """SINGLE containment verdict: ``p`` is inside the workspace ``root``, or
    inside one of the workspace's harmless scratch dirs (test logs, /dev/null)
    — provided the root itself is not inside that scratch dir (a /tmp-hosted
    workspace must still flag its own escapes). Shared by ``Workspace.resolve``
    (real-path guard) and ``Workspace.escape_path`` (permission gate), so the
    two can never disagree. ``p``, ``root`` and ``scratches`` must share one
    path flavor — mixing PurePosixPath with a host WindowsPath raises."""
    if _is_relative_to(p, root):
        return True
    for scratch in scratches:
        if _is_relative_to(p, scratch) and not _is_relative_to(root, scratch):
            return True
    return False


class Workspace(ABC):
    def __init__(self, root: str | None = None, transport: Transport | None = None) -> None:
        # _root_path picks the path FLAVOR: a host Path here (a remote root is
        # that machine's own server's LocalWorkspace, never this object's)
        self.root: PurePath = self._root_path(root) if root else Path(tempfile.mkdtemp(prefix="clutch-"))
        # No local mkdir here on purpose: this base owns the root spelling only
        # and LocalWorkspace ensures the directory in its own __init__. Creating
        # it here broke macOS (/home is an autofs mount: mkdir -> [Errno 45]
        # ENOTSUP -> "cannot create project").
        self._transport = transport or LocalTransport(str(self.root))
        self._protected: set[Path] = set()
        # absolute paths outside the root the CURRENT tool call may touch;
        # granted by the permission gate, cleared after every tool call
        self._allowed_escapes: set[Path] = set()
        # per-file undo stack: previous contents recorded before every overwrite
        self._snapshots: dict[str, list[str]] = {}
        # The TURN JOURNAL: every file a component's write replaced (or created),
        # keyed by the log offset of the user task that was running when it
        # changed (begin_turn). It answers the UI's "roll back to this task":
        # undoing a task means undoing every recorded mutation at or after that
        # task's offset, newest first, and DELETING the files that did not exist
        # before — a creation is not something the per-file undo stack above can
        # express, which is why the journal is its own record.
        self._journal: list[tuple[int, str, bool, str]] = []  # (anchor, path, existed, content)
        self._journal_anchor: int | None = None
        self._journal_lock = threading.Lock()

    def allow(self, paths) -> None:
        """Record user-approved external paths for the current tool call."""
        self._allowed_escapes |= {self.realpath(p) for p in paths}

    def clear_allowed(self) -> None:
        """Drop the per-call escape allowance (called after every tool call)."""
        self._allowed_escapes.clear()

    def snapshot(self, path: Path, content: str) -> None:
        """Record the previous content of a file before an overwrite (undo stack)."""
        key = str(self.realpath(path))
        stack = self._snapshots.setdefault(key, [])
        stack.append(content)
        if len(stack) > _MAX_SNAPSHOTS_PER_FILE:
            stack.pop(0)

    def restore(self, path: Path) -> str | None:
        """Pop the last snapshot and write it back; returns the restored content
        (None when there is no snapshot for this file)."""
        key = str(self.realpath(path))
        stack = self._snapshots.get(key)
        if not stack:
            return None
        content = stack.pop()
        self.write(str(path), content)
        return content

    # ---- the turn journal (the UI's whole-task rollback) ---------------------

    def begin_turn(self, anchor: int) -> None:
        """Open a rollback checkpoint at the log offset of the user task about to
        run: mutations recorded from here on belong to that task AND every task
        after it, which is exactly the set "roll back to this task" undoes."""
        with self._journal_lock:
            self._journal_anchor = int(anchor)

    def record_mutation(self, path: Path | str, existed: bool, previous: str = "") -> None:
        """Journal one file mutation — the HOST's own record, kept beside the
        component's write rather than asked of it (the workspace is what knows a
        task boundary). ``existed`` False means the write CREATED the path, so a
        rollback removes it instead of restoring content. Nothing is recorded
        when no checkpoint is open (a tool call outside a run has no task to be
        rolled back with, and inventing one would offer the UI an undo that
        restores state no task ever produced)."""
        with self._journal_lock:
            if self._journal_anchor is None:
                return
            self._journal.append((self._journal_anchor, str(path), bool(existed), previous))

    def rollback_anchors(self) -> list[int]:
        """The log offsets a rollback checkpoint actually exists for, ascending.
        The UI asks this to know whether a task row can offer "roll back to
        here" at all (a task that changed nothing has no record)."""
        with self._journal_lock:
            return sorted({anchor for anchor, _path, _existed, _content in self._journal})

    def rollback_from(self, anchor: int) -> dict[str, list[str]] | None:
        """Undo every journaled mutation at or after ``anchor`` and report what
        changed; None when nothing was recorded for that task or any later one.

        The entries are applied NEWEST FIRST, which is what makes the same path
        written twice come out right: the later write is undone to its
        intermediate content, then the earlier one to what preceded it — and a
        file created and then rewritten ends up deleted, exactly where the task
        found the workspace. A path that cannot be put back (permissions, a file
        removed by a shell command) is reported by omission rather than aborting
        the rest of the rollback. The journal entries that were undone are
        dropped: their effect is gone, and a second rollback to the same task
        must not restore pre-task content over work done since.
        """
        with self._journal_lock:
            picked = [entry for entry in self._journal if entry[0] >= anchor]
            if not picked:
                return None
            self._journal = [entry for entry in self._journal if entry[0] < anchor]
        restored: list[str] = []
        deleted: list[str] = []
        for _anchor, path, existed, content in reversed(picked):
            try:
                if existed:
                    self.write(path, content)
                    restored.append(path)
                else:
                    self.delete(path)
                    deleted.append(path)
            except (OSError, ValueError):
                continue  # not put back; left out of the report instead of guessed
        return {"restored": restored, "deleted": deleted}

    def protect(self, path: Path) -> None:
        """Mark a file as invisible/unusable to the agent (e.g. the .clc project file)."""
        self._protected.add(self.realpath(path))

    def is_protected(self, path: Path) -> bool:
        """Whether the workspace hides this path (e.g. the .clc project file).

        Deliberately unguarded: realpath is total (see its docstring), so a path
        that cannot be normalized — a symlink loop — yields a path that simply is
        not the protected file, instead of an exception the caller has to guess
        the meaning of. The old `except OSError: return False` guarded an
        exception Path.resolve() never raises on POSIX while the one it does
        raise (RuntimeError, "symlink loop") went straight through it."""
        return self.realpath(path) in self._protected

    def protected(self) -> set[Path]:
        """Snapshot of the protected set: the workspace daemon is spawned with
        these as its fence globs (it hides them from broad sweeps and refuses
        mutations), and every tool call re-checks them host-side."""
        return set(self._protected)

    def visible_entries(self, root: Path) -> list[Path]:
        """Directory entries excluding protected files."""
        out = []
        for ent in sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if self.is_protected(ent):
                continue
            out.append(ent)
        return out

    def _root_path(self, root: str) -> PurePath:
        """Path flavor for the workspace root: the host's Path locally."""
        return Path(root)

    def _scratch_dirs(self) -> tuple[PurePath, ...]:
        """Harmless scratch dirs for escape verdicts (test logs, /dev/null),
        in the workspace's OWN path flavor: the host temp dir on Windows (there
        is no /tmp), the POSIX trio on POSIX hosts."""
        if os.name == "nt":
            return (Path(tempfile.gettempdir()),)
        return (Path("/tmp"), Path("/var/tmp"), Path("/dev"))

    def shell_path(self, token: str) -> str:
        """The local path a SHELL token denotes (identity by default).

        Command text is parsed by the shell, not by us, so its spelling can
        denote something the host's own path rules never produce: on Windows
        under Git Bash (the POSIX flavor the agent speaks) `/tmp` IS %TEMP% and
        `/dev/null` IS the NUL device — both as harmless as on Linux. Everyone
        who reasons about command TEXT (the permission engine's escape parser,
        the shell guard's token rejection) asks here, so the verdict follows the
        shell that will run the text instead of guessing from the OS. A tool's
        `path` argument is NOT a shell token and keeps the plain spelling."""
        return token

    def norm_join(self, base: str, token: str) -> PurePath:
        """Lexical base+token join for escape verdicts and the `cd` tracker, in
        the workspace's own path flavor (os.path, so Windows joins with ntpath)."""
        return Path(os.path.normpath(os.path.join(base, token)))

    def realpath(self, path: Path | str) -> Path:
        """Normalize a workspace path for bookkeeping (containment checks, the
        protected set, undo keys, escape verdicts), resolving symlinks through
        the OS. Everything internal goes through this hook so the callers cannot
        drift.

        The normalization is TOTAL: os.path.realpath instead of
        Path.resolve(), which raises RuntimeError("Symlink loop from ...") on a
        loop (CPython 3.10 — a RuntimeError is not an OSError, so no caller's
        `except OSError` ever saw it). A loop IS a real directory entry, and
        every caller of this hook is doing bookkeeping — comparing, keying,
        contained-or-not — that must not throw across a boundary because one
        entry cannot be resolved. realpath answers with the path it could not
        resolve through, which is exactly "not the target, and not the .clc";
        the operation that actually opens the path reports ELOOP itself.
        Verified identical to Path.resolve() for every other input (existing,
        missing, dangling, chained, relative, `..` through a symlink)."""
        return Path(os.path.realpath(path))

    def home(self) -> Path:
        """The home directory a leading `~` expands to for this workspace: the
        app user's home."""
        return Path.home()

    def exec_shell(self) -> LocalShell:
        """The shell run_command text executes under (see tools.localshell):
        the app host's decision (posix sh / Git Bash / cmd). Everyone who
        reasons about command TEXT — the shell guard's tokenizer, the permission
        engine's escape parser, the context platform hint — must agree with the
        shell that actually parses the command, so they read the flavor from
        here instead of guessing from the OS."""
        return local_shell()

    def resolve(self, rel_path: str) -> Path:
        """Resolve a path to inside the workspace (or a user-approved external
        path); raise ValueError on an unapproved escape. The root is resolved
        too, so a symlinked spelling of the workdir (or a subfolder) still
        counts as inside. The FINAL component's symlink is not followed for the
        containment check: a project-local symlink such as .venv/bin/python
        (-> /usr/bin/python3.10) must read as inside the workspace, not as an
        escape. The OS follows it when the path is actually opened."""
        root = self.realpath(self.root)
        base = root / rel_path
        try:
            if base.name:
                p = self.realpath(base.parent) / base.name
            else:
                p = self.realpath(base)
        except (OSError, ValueError):
            p = self.realpath(base)
        if p in self._allowed_escapes or _inside_or_scratch(p, root, self._scratch_dirs()):
            return p
        raise ValueError(f"path escapes workspace: {rel_path!r}")

    def escape_path(self, token: str, anchor: PurePath | None = None) -> PurePath | None:
        """Lexical escape verdict for one path token: the absolute path it
        refers to OUTSIDE the workspace, or None when it stays inside (or in a
        harmless scratch dir). ``anchor`` is the directory the token is
        relative to — the workspace root by default, or the ``cd``'d dir for a
        run_command (``cd sub && ../x`` is judged from sub, not the root).
        This is the single source of truth behind the permission gate's escape
        list AND the shell guard's token rejection."""
        if not token:
            return None
        if token.startswith("~"):
            # workspace.home(), not expanduser: the hook is the one place that
            # decides whose home `~` denotes
            token = str(self.home()) + token[1:]
        base = anchor if anchor is not None else self.root
        root = self.realpath(self.root)
        p = self.norm_join(str(base), token)
        if _inside_or_scratch(p, root, self._scratch_dirs()):
            return None
        return p

    def run(self, command: str, timeout: float, cancel: threading.Event | None = None) -> CommandResult:
        """Run a shell command in the workspace; transport-specific cwd handling.
        ``cancel`` is Stop: the transport kills the command tree promptly."""
        return self._transport.run(command, timeout, cancel=cancel)

    @abstractmethod
    def read(self, path: str) -> str:
        """Return file contents; raise FileNotFoundError if missing."""

    @abstractmethod
    def read_range(self, path: str, lo: int, hi: int) -> bytes:
        """Return the file's byte range [lo, hi) as RAW BYTES (the lazy log's
        indexed reads: exact byte offsets, so materialization matches the file).
        The range may cut mid-multibyte-character — implementations must round
        the bytes through losslessly."""

    @abstractmethod
    def size(self, path: str) -> int:
        """Total file size in bytes (O(1) metadata, no content transfer)."""

    @abstractmethod
    def write(self, path: str, content: str) -> None:
        """Create or overwrite a file (parents created as needed)."""

    @abstractmethod
    def list(self, path: str) -> list[str]:
        """Directory entries (dirs end with '/'), protected files excluded; raise NotADirectoryError."""

    @abstractmethod
    def append_line(self, path: str, line: str) -> None:
        """Append one line to a file (the .clc writer)."""

    @abstractmethod
    def write_at(self, path: str, offset: int, data: bytes) -> None:
        """Overwrite bytes [offset, offset + len(data)) IN PLACE (the .clc
        header's fixed-width memory index line). Never changes the file size
        and never touches bytes outside the range; implementations must
        round the raw bytes losslessly."""

    @abstractmethod
    def delete(self, path: str) -> None:
        """Remove a file (the rollback of a CREATION: the journal is the only
        thing that knows a path did not exist before the task). Raises OSError
        when it cannot be removed."""

    @abstractmethod
    def grep(self, pattern: str, path: str = ".", include: str | None = None) -> list[tuple[str, int, str]]:
        """Regex search over workspace files (skips hidden/binary/protected).
        Returns [(root-relative path, 1-based line, text)], capped at 100 hits."""


class LocalWorkspace(Workspace):
    def __init__(self, root: str | None = None, transport: Transport | None = None) -> None:
        super().__init__(root, transport)
        self.root.mkdir(parents=True, exist_ok=True)

    def shell_path(self, token: str) -> str:
        """Windows + Git Bash: translate the POSIX scratch spellings the agent
        writes (`> /tmp/out.log 2>&1`, `2> /dev/null`, `head -c 8 /dev/urandom`)
        to what bash itself resolves them to — /tmp is %TEMP% under MSYS
        (`cygpath -w /tmp`), /dev/null is the NUL device, and the REST of the
        POSIX scratch surface (/dev/* device nodes, /var/tmp) is MSYS-internal,
        so it is mapped into the host scratch dir too. Without this the verdict
        engine joins the token with ntpath instead, lands on `C:\\tmp\\out.log`
        or `C:\\dev\\urandom`, and rejects an ordinary redirect as a workspace
        escape — which it is not on the POSIX side, where all those dirs are
        scratch. Only reached when the local shell is the POSIX flavor: under
        cmd.exe the very same token is a drive-relative path and must be judged
        literally."""
        if os.name != "nt" or not local_shell().posix:
            return token
        tmp = tempfile.gettempdir()
        if token == "/dev/null":
            return os.devnull
        tail = posix_scratch_tail(token)
        if tail is None:
            # not scratch — or a `..` climbed back out of it (an escape on
            # POSIX too): judge the token as the host would, so it stays one
            return token
        return os.path.join(tmp, *tail.split("/")) if tail else tmp

    def read(self, path: str) -> str:
        p = self.resolve(path)
        if not p.is_file():
            raise FileNotFoundError(path)
        return p.read_text(encoding="utf-8", errors="replace")

    def read_range(self, path: str, lo: int, hi: int) -> bytes:
        p = self.resolve(path)
        with open(p, "rb") as f:
            f.seek(lo)
            return f.read(hi - lo)

    def size(self, path: str) -> int:
        return os.path.getsize(self.resolve(path))

    def write(self, path: str, content: str) -> None:
        p = self.resolve(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        # newline="\n": byte-exact on every host. The .clc project file is
        # byte-addressed (offsets + in-place header updates), and the SSH bridge
        # writes LF, so the local backend must not let Windows text mode expand
        # every \n into \r\n (that desynchronizes every stored offset).
        # open(), not write_text(newline=…): that keyword is 3.10+ and these are
        # the same bytes without it, so the declared 3.8 floor holds here too.
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)

    def list(self, path: str) -> list[str]:
        p = self.resolve(path)
        if not p.is_dir():
            raise NotADirectoryError(path)
        return sorted(f.name + ("/" if f.is_dir() else "") for f in self.visible_entries(p))

    def append_line(self, path: str, line: str) -> None:
        p = self.resolve(path)
        # one LF terminator per line (the remote bridge's `printf '%s\n'` shape):
        # the .clc JSONL offsets count exactly one newline byte per event
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")

    def write_at(self, path: str, offset: int, data: bytes) -> None:
        p = self.resolve(path)
        with open(p, "r+b") as f:
            f.seek(offset)
            f.write(data)

    def delete(self, path: str) -> None:
        # missing_ok: same tolerance as the remote `rm -f` — the rollback that
        # un-creates a file must survive the user having removed it by hand
        self.resolve(path).unlink(missing_ok=True)

    def grep(self, pattern: str, path: str = ".", include: str | None = None) -> list[tuple[str, int, str]]:
        rx = re.compile(pattern)
        root = self.resolve(path)
        files = [root] if root.is_file() else self._grep_files(root)
        out: list[tuple[str, int, str]] = []
        for f in files:
            if self.is_protected(f):
                continue
            rel = str(f.relative_to(self.root))
            if include and not (fnmatch.fnmatch(f.name, include) or fnmatch.fnmatch(rel, include)):
                continue
            if self._is_binary(f):
                continue
            try:
                with open(f, encoding="utf-8", errors="replace") as fh:
                    for i, line in enumerate(fh, 1):
                        if rx.search(line):
                            out.append((rel, i, line.rstrip("\n")))
                            if len(out) >= 100:
                                return out
            except OSError:
                continue
        return out

    def _grep_files(self, dirpath: Path) -> list[Path]:
        files: list[Path] = []
        for ent in sorted(dirpath.iterdir()):
            if ent.name.startswith(".") or ent.name == "__pycache__":
                continue
            if ent.is_dir():
                files.extend(self._grep_files(ent))
            elif ent.is_file():
                files.append(ent)
        return files

    @staticmethod
    def _is_binary(p: Path) -> bool:
        try:
            with open(p, "rb") as f:
                return b"\x00" in f.read(1024)
        except OSError:
            return True


# undo stack depth per file (snapshots before each overwrite)
_MAX_SNAPSHOTS_PER_FILE = 5
