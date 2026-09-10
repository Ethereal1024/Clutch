"""Workspace directory + path safety.

The agent works in the project's directory (the folder containing its .clc file).
Paths are resolved then checked to stay inside the workspace root; permission
rules guard risky actions. Certain files (the project's own .clc) are protected:
the agent cannot read, write, or even list them.

Workspace is the base class: it owns root/path-safety/transport and lets
subclasses define how files are actually touched. LocalWorkspace uses Path
operations; RemoteWorkspace (SSH degradation layer) maps read/write/list to sh
commands executed through the transport. Tools only see the Workspace interface,
so local and remote behave identically.
"""

from __future__ import annotations

import fnmatch
import json
import os
import posixpath
import re
import tempfile
import time
from abc import ABC, abstractmethod
from pathlib import Path, PurePath, PurePosixPath

from .transport import CommandResult, LocalTransport, SshTransport, Transport, TransportError


def shq(s: str) -> str:
    """Single-quote a path for sh: `'` -> `'\\''` (works on any POSIX shell)."""
    return "'" + s.replace("'", "'\\''") + "'"


def parse_ls_entries(stdout: str) -> list[tuple[str, bool]]:
    """Parse `ls -1AF` output into [(name, is_dir)] in listing order.

    ls -1AF marks dirs with a trailing '/', executables with '*', symlinks with
    '@'; the '*'/'@' suffixes are stripped. Hidden filtering is deliberately NOT
    done here: the three call sites disagree on it (the server's fs list shows
    hidden dirs but not hidden files; the tree walk hides both), so each site
    applies its own rule after this shared parse.
    """
    out: list[tuple[str, bool]] = []
    for entry in stdout.splitlines():
        if not entry:
            continue
        if entry.endswith("/"):  # ls -1AF marks dirs with a trailing /
            out.append((entry[:-1], True))
            continue
        name = entry[:-1] if entry[-1] in ("*", "@") else entry
        out.append((name, False))
    return out


# Single source for the remote-wire limits, shared with ui/ssh-tunnel.js
_DEFAULTS = json.loads((Path(__file__).resolve().parent.parent / "transport_defaults.json").read_text(encoding="utf-8"))

# Scratch dirs that are harmless to write to (test logs, /dev/null redirects).
# POSIX spellings; see Workspace._scratch_dirs for how they are flavored per
# workspace kind (a Windows LOCAL host has no /tmp; the REMOTE host is the
# POSIX side).
POSIX_SCRATCH_DIRS = ("/tmp", "/var/tmp", "/dev")


def _inside_or_scratch(p: PurePath, root: PurePath, scratches: tuple[PurePath, ...]) -> bool:
    """SINGLE containment verdict: ``p`` is inside the workspace ``root``, or
    inside one of the workspace's harmless scratch dirs (test logs, /dev/null)
    — provided the root itself is not inside that scratch dir (a /tmp-hosted
    workspace must still flag its own escapes). Shared by ``Workspace.resolve``
    (real-path guard) and ``Workspace.escape_path`` (permission gate), so the
    two can never disagree. ``p``, ``root`` and ``scratches`` must share one
    path flavor — mixing PurePosixPath with a host WindowsPath raises."""
    if p.is_relative_to(root):
        return True
    for scratch in scratches:
        if p.is_relative_to(scratch) and not root.is_relative_to(scratch):
            return True
    return False


class Workspace(ABC):
    def __init__(self, root: str | None = None, transport: Transport | None = None) -> None:
        # _root_path picks the path FLAVOR: the host's Path locally, PurePosixPath
        # remotely (a Windows client's Path would re-separator remote /-paths
        # with backslashes before they were ever sent over the bridge)
        self.root: PurePath = self._root_path(root) if root else Path(tempfile.mkdtemp(prefix="clutch-"))
        # No local mkdir here on purpose: this base also serves RemoteWorkspace,
        # whose root lives on another HOST. Creating it locally broke macOS
        # (/home is an autofs mount: mkdir -> [Errno 45] ENOTSUP -> "cannot
        # create project"). LocalWorkspace ensures its root in its own
        # __init__; the remote side creates what it needs (mkdir -p on write).
        self._transport = transport or LocalTransport(str(self.root))
        self._protected: set[Path] = set()
        # absolute paths outside the root the CURRENT tool call may touch;
        # granted by the permission gate, cleared after every tool call
        self._allowed_escapes: set[Path] = set()
        # per-file undo stack: previous contents recorded before every overwrite
        self._snapshots: dict[str, list[str]] = {}

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

    def protect(self, path: Path) -> None:
        """Mark a file as invisible/unusable to the agent (e.g. the .clc project file)."""
        self._protected.add(self.realpath(path))

    def is_protected(self, path: Path) -> bool:
        try:
            return self.realpath(path) in self._protected
        except OSError:
            return False

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
        in the workspace's OWN path flavor. Local: the host temp dir on Windows
        (there is no /tmp), the POSIX trio on POSIX hosts. Remote: overridden —
        the remote host is the POSIX side, in PurePosixPath flavor."""
        if os.name == "nt":
            return (Path(tempfile.gettempdir()),)
        return (Path("/tmp"), Path("/var/tmp"), Path("/dev"))

    def norm_join(self, base: str, token: str) -> PurePath:
        """Lexical base+token join for escape verdicts and the `cd` tracker, in
        the workspace's own path flavor: host os.path locally, posixpath
        remotely (on Windows ntpath would backslash-rewrite remote paths)."""
        return Path(os.path.normpath(os.path.join(base, token)))

    def realpath(self, path: Path | str) -> Path:
        """Normalize a workspace path for bookkeeping (containment checks, the
        protected set, undo keys, escape verdicts). LOCAL workspaces resolve
        symlinks through the OS; REMOTE workspaces must NOT touch the local
        filesystem at all: the app host's filesystem knows nothing about the
        remote host's layout, and resolving a remote path locally rewrote it
        with the app host's spelling of /home (on macOS the autofs target
        /System/Volumes/Data/home) before the remote ever saw it. Everything
        internal goes through this hook so the two can never drift."""
        return Path(path).resolve()

    def home(self) -> Path:
        """The home directory a leading `~` expands to for this workspace.
        Local: the app user's home; remote: the REMOTE user's home — a `~` in
        a remote path must never expand to the app host's home."""
        return Path.home()

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
            # workspace.home(), not expanduser: in ssh mode `~` is the REMOTE
            # user's home, never the app host's
            token = str(self.home()) + token[1:]
        base = anchor if anchor is not None else self.root
        root = self.realpath(self.root)
        p = self.norm_join(str(base), token)
        if _inside_or_scratch(p, root, self._scratch_dirs()):
            return None
        return p

    def run(self, command: str, timeout: float) -> CommandResult:
        """Run a shell command in the workspace; transport-specific cwd handling."""
        return self._transport.run(command, timeout)

    @abstractmethod
    def read(self, path: str) -> str:
        """Return file contents; raise FileNotFoundError if missing."""

    @abstractmethod
    def read_range(self, path: str, lo: int, hi: int) -> bytes:
        """Return the file's byte range [lo, hi) as RAW BYTES (the lazy log's
        indexed reads: exact byte offsets, so materialization matches the file).
        The range may cut mid-multibyte-character — implementations must round
        the bytes through losslessly (remote: the transport's binary mode base64-encodes
        client-side, so the remote needs no base64)."""

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
        """Append one line to a file (the remote .clc writer)."""

    @abstractmethod
    def write_at(self, path: str, offset: int, data: bytes) -> None:
        """Overwrite bytes [offset, offset + len(data)) IN PLACE (the .clc
        header's fixed-width memory index line). Never changes the file size
        and never touches bytes outside the range; implementations must
        round the raw bytes losslessly (remote: the transport's binary mode keeps bytes
        exact without a remote base64)."""

    @abstractmethod
    def grep(self, pattern: str, path: str = ".", include: str | None = None) -> list[tuple[str, int, str]]:
        """Regex search over workspace files (skips hidden/binary/protected).
        Returns [(root-relative path, 1-based line, text)], capped at 100 hits."""


class LocalWorkspace(Workspace):
    def __init__(self, root: str | None = None, transport: Transport | None = None) -> None:
        super().__init__(root, transport)
        self.root.mkdir(parents=True, exist_ok=True)

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
        p.write_text(content, encoding="utf-8")

    def list(self, path: str) -> list[str]:
        p = self.resolve(path)
        if not p.is_dir():
            raise NotADirectoryError(path)
        return sorted(f.name + ("/" if f.is_dir() else "") for f in self.visible_entries(p))

    def append_line(self, path: str, line: str) -> None:
        p = self.resolve(path)
        with open(p, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def write_at(self, path: str, offset: int, data: bytes) -> None:
        p = self.resolve(path)
        with open(p, "r+b") as f:
            f.seek(offset)
            f.write(data)

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


# Minimal sshd drops a single exec over ~8KB: writes are chunked below it;
# limits come from transport_defaults.json (shared with ui/ssh-tunnel.js).
_EXEC_CHUNK_BYTES = int(_DEFAULTS["exec_chunk_bytes"])
_EXEC_MAX_COMMAND_BYTES = int(_DEFAULTS["exec_max_command_bytes"])

# generous per-op timeout for internal remote file ops (read/write/list/append)
_REMOTE_IO_TIMEOUT = 60.0
# how much of a failed exec's stderr/stdout to show in the raised error
_ERR_SNIPPET = 300
# undo stack depth per file (snapshots before each overwrite)
_MAX_SNAPSHOTS_PER_FILE = 5


class RemoteWorkspace(Workspace):
    """Workspace whose files live on a remote host reached over the exec bridge.

    Every exec starts a fresh shell, so read/write/list use absolute paths and
    run() prefixes `cd '<root>' &&` for the same cwd semantics as LocalWorkspace.
    File operations are plain POSIX sh — cat, ls, and `printf '%s'` appends (no
    base64, no SFTP) — so any device that can run an sshd shell works. Writes and
    appends are chunked so no single exec command exceeds the sshd's limit.
    """

    def __init__(self, root: str | None, bridge_url: str) -> None:
        super().__init__(root, transport=SshTransport(bridge_url))
        self._remote_home: str | None = None

    def _root_path(self, root: str) -> PurePath:
        """PurePosixPath, never the host's Path: remote paths are POSIX, and a
        Windows client's Path (WindowsPath) would turn their '/' separators
        into '\\' in every str() — mangling every command sent over the bridge.
        PurePosixPath keeps the spelling host-independent."""
        return PurePosixPath(root)

    def _scratch_dirs(self) -> tuple[PurePath, ...]:
        # the remote runs the POSIX shell stack: keep the POSIX trio in the
        # REMOTE path flavor so the verdict never mixes PurePosixPath with a
        # host WindowsPath (TypeError)
        return tuple(PurePosixPath(s) for s in POSIX_SCRATCH_DIRS)

    def norm_join(self, base: str, token: str) -> PurePath:
        """posixpath, not the host's os.path: the token is judged against the
        REMOTE layout (on Windows ntpath would backslash it)."""
        return PurePosixPath(posixpath.normpath(posixpath.join(base, token)))

    def realpath(self, path: PurePath | str) -> PurePath:
        """LEXICAL normalization only — never a local filesystem call.

        Every path here lives on the REMOTE host, so the app host's view of the
        filesystem must not rewrite it: on the macOS app host,
        Path('/home/u/p').resolve() spelled /home through the local autofs
        layout (/System/Volumes/Data/home/u/p), and the project write then ran
        `mkdir -p '/System/...'` on the Linux remote -> permission denied.
        normpath collapses `..`, `.` and duplicate slashes without consulting
        any filesystem; remote-side symlinks stay invisible to the client, so
        containment is lexical here exactly like escape_path's verdict. The
        backslash rewrite tolerates a caller that str()'d a host Path first.
        """
        return PurePosixPath(posixpath.normpath(str(path).replace("\\", "/")))

    def home(self) -> PurePath:
        """The REMOTE user's home for `~` tokens: one cached exec (`echo $HOME`
        over the bridge) instead of expanduser, which would return the app
        host's home. On failure falls back to the literal `~` — a relative-ish
        path that reads as an escape and asks the user, never silently maps a
        remote path onto the app host. PurePosixPath: a Windows host's
        Path('/home/u') would str() backslash it."""
        if self._remote_home is None:
            r = self._transport.run("echo $HOME", _REMOTE_IO_TIMEOUT)
            self._remote_home = r.stdout.strip() if (r.code == 0 and r.stdout.strip()) else "~"
        return PurePosixPath(self._remote_home)

    def run(self, command: str, timeout: float) -> CommandResult:
        cmd = f"cd {shq(str(self.root))} && {command}"
        # oversized exec commands drop a minimal sshd: fail cleanly up front
        size = len(cmd.encode("utf-8"))
        if size > _EXEC_MAX_COMMAND_BYTES:
            raise TransportError(
                f"command too long to send over the remote transport ({size} bytes); "
                "write large content with write_file and run it"
            )
        return self._transport.run(cmd, timeout)

    def read(self, path: str) -> str:
        p = self.resolve(path)
        r = self._transport.run(f"cat {shq(str(p))}", _REMOTE_IO_TIMEOUT)
        if r.code != 0:
            raise FileNotFoundError(str(p))
        return r.stdout

    def read_range(self, path: str, lo: int, hi: int) -> bytes:
        """Byte range [lo, hi) as RAW bytes. The exec bridge carries text, so the
        transport's binary mode base64-encodes the slice CLIENT-side: every byte
        round-trips exactly even when the range cuts mid-multibyte-character, and
        the remote needs no base64 binary (just tail/head — minimal hosts lack it)."""
        p = self.resolve(path)
        r = self._transport.run(
            f"tail -c +{lo + 1} {shq(str(p))} | head -c {hi - lo}", _REMOTE_IO_TIMEOUT, binary=True
        )
        if r.code != 0:
            raise OSError(f"cannot read {p} (exit {r.code}): {(r.stderr or r.stdout)[:_ERR_SNIPPET]}")
        return r.stdout.encode("latin-1")

    def size(self, path: str) -> int:
        """Total file size in bytes: wc -c on a regular file stats it (O(1)),
        no content transfer."""
        p = self.resolve(path)
        r = self._transport.run(f"wc -c < {shq(str(p))}", _REMOTE_IO_TIMEOUT)
        if r.code != 0:
            raise FileNotFoundError(str(p))
        return int(r.stdout.strip())

    def _chunk_content(self, content: str) -> list[str]:
        """Split into pieces whose ON-WIRE size (after shq quoting) stays under
        _EXEC_CHUNK_BYTES. A single quote inflates to the 4-char sequence '\''
        in the shell command, so it is budgeted at 4; multibyte chars are never
        split mid-character."""
        chunks: list[str] = []
        cur: list[str] = []
        size = 0
        for ch in content:
            sz = 4 if ch == "'" else len(ch.encode("utf-8"))
            if cur and size + sz > _EXEC_CHUNK_BYTES:
                chunks.append("".join(cur))
                cur, size = [ch], sz
            else:
                cur.append(ch)
                size += sz
        if cur:
            chunks.append("".join(cur))
        return chunks

    def _exec_append(
        self,
        p: Path,
        content: str,
        first_op: str,
        add_trailing_nl: bool,
        ensure_dir: bool,
    ) -> None:
        """Write/append content via one small `printf '%s'` per chunk.

        printf is a POSIX sh builtin (present even where base64 is not) and `%s`
        emits its argument byte-for-byte with no added newline, so chunks can be
        cut anywhere and the file stays byte-exact. The last chunk optionally
        uses `%s\\n` to restore the JSONL terminator.
        """
        chunks = self._chunk_content(content) or [""]
        for i, chunk in enumerate(chunks):
            fmt = "%s\n" if (add_trailing_nl and i == len(chunks) - 1) else "%s"
            op = first_op if i == 0 else ">>"
            prefix = f"mkdir -p {shq(str(p.parent))} && " if (ensure_dir and i == 0) else ""
            cmd = f"{prefix}printf '{fmt}' {shq(chunk)} {op} {shq(str(p))}"
            r = self._transport.run(cmd, _REMOTE_IO_TIMEOUT)
            if r.code != 0:
                raise OSError(f"write failed (exit {r.code}): {(r.stderr or r.stdout)[:_ERR_SNIPPET]}")

    def write(self, path: str, content: str) -> None:
        p = self.resolve(path)
        self._exec_append(p, content, first_op=">", add_trailing_nl=False, ensure_dir=True)

    def list(self, path: str) -> list[str]:
        p = self.resolve(path)
        # test -d first: ls alone succeeds on a plain file
        r = self._transport.run(f"test -d {shq(str(p))} && ls -1AF {shq(str(p))}", _REMOTE_IO_TIMEOUT)
        if r.code != 0:
            raise NotADirectoryError(str(p))
        return self._parse_list_output(p, r.stdout)

    def _parse_list_output(self, p: Path, stdout: str) -> list[str]:
        """One shared ls parser + the protected-file filter (protected dirs stay
        listed — the agent sees the dir but cannot read inside it)."""
        out = []
        for name, is_dir in parse_ls_entries(stdout):
            if not is_dir and self.is_protected(p / name):
                continue
            out.append(name + ("/" if is_dir else ""))
        return sorted(out)

    def list_many(self, paths: list[str]) -> dict[str, list[str]]:
        """list several directories in ONE exec (one round trip); missing/non-dir
        paths map to []. Used by the remote tree walk so a whole level costs a
        single round trip instead of one exec per directory. Commands are grouped
        so each exec stays under the sshd's command-size limit."""
        keyed = [(p, self.resolve(p)) for p in paths]
        marker = f"CLUTCH_LIST_{time.time_ns()}"
        result: dict[str, list[str]] = {p: [] for p in paths}
        groups: list[tuple[list[tuple[str, Path, str]], str]] = []
        cur_cmd: list[str] = []
        cur_group: list[tuple[str, Path, str]] = []
        for i, (rel, p) in enumerate(keyed):
            m = f"{marker}_{i}"
            frag = f"if test -d {shq(str(p))}; then echo '{m}'; ls -1AF {shq(str(p))}; else echo '{m}:MISSING'; fi"
            if cur_cmd and sum(len(f) + 2 for f in cur_cmd) + len(frag) > _EXEC_MAX_COMMAND_BYTES - 200:
                groups.append((cur_group, "; ".join(cur_cmd)))
                cur_cmd, cur_group = [], []
            cur_cmd.append(frag)
            cur_group.append((rel, p, m))
        if cur_cmd:
            groups.append((cur_group, "; ".join(cur_cmd)))
        for group, cmd in groups:
            r = self._transport.run(cmd, _REMOTE_IO_TIMEOUT)
            if r.code != 0:
                raise OSError(f"list failed (exit {r.code}): {(r.stderr or r.stdout)[:_ERR_SNIPPET]}")
            raw: dict[str, list[str]] = {}
            current: str | None = None
            for line in r.stdout.splitlines():
                if line.startswith(marker):
                    idx = int(line[len(marker) + 1 :].split(":", 1)[0])
                    current = group[idx][0]
                    continue
                if current is not None:
                    raw.setdefault(current, []).append(line)
            for rel, p, _ in group:
                result[rel] = self._parse_list_output(p, "\n".join(raw.get(rel, [])))
        return result

    def append_line(self, path: str, line: str) -> None:
        p = self.resolve(path)
        self._exec_append(p, line, first_op=">>", add_trailing_nl=True, ensure_dir=False)

    def write_at(self, path: str, offset: int, data: bytes) -> None:
        """In-place overwrite at a byte offset (the .clc memory index header
        line). The bytes travel as POSIX octal escapes through printf %b (a sh
        builtin — the remote needs no base64); dd with conv=notrunc writes over
        the range without truncating the file or touching anything past it."""
        p = self.resolve(path)
        octal = "".join(f"\\{b:03o}" for b in data)
        cmd = (
            f"printf '%b' '{octal}' | "
            f"dd of={shq(str(p))} bs=1 seek={offset} conv=notrunc"
        )
        r = self._transport.run(cmd, _REMOTE_IO_TIMEOUT)
        if r.code != 0:
            raise OSError(f"cannot write_at {p} (exit {r.code}): {(r.stderr or r.stdout)[:_ERR_SNIPPET]}")

    def grep(self, pattern: str, path: str = ".", include: str | None = None) -> list[tuple[str, int, str]]:
        # busybox grep lacks --include/dotfile awareness: use find, skip hidden
        # files/dirs and the protected .clc
        p = self.resolve(path)
        find_cmd = f"find {shq(str(p))} -type f ! -path '*/.*' ! -path '*/.*/*'"
        for prot in self._protected:
            find_cmd += f" ! -name {shq(prot.name)}"
        if include:
            find_cmd += f" -name {shq(include)}"
        cmd = f"{find_cmd} -print0 | xargs -0 grep -HnE {shq(pattern)} | head -n 100"
        r = self._transport.run(cmd, _REMOTE_IO_TIMEOUT)
        if r.code != 0 and not r.stdout:
            return []
        out: list[tuple[str, int, str]] = []
        for line in r.stdout.splitlines():
            first = line.find(":")
            if first < 0:
                continue
            rest = line[first + 1 :]
            second = rest.find(":")
            if second < 0:
                continue
            try:
                lineno = int(rest[:second])
            except ValueError:
                continue
            fpath = line[:first]
            try:
                # PurePosixPath: the remote prints POSIX paths; the host's Path
                # flavor must not re-separator them (WindowsPath on Windows)
                rel = str(PurePosixPath(fpath).relative_to(self.root))
            except ValueError:
                rel = fpath
            out.append((rel, lineno, rest[second + 1 :]))
            if len(out) >= 100:
                break
        return out
