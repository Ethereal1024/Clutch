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

import tempfile
from abc import ABC, abstractmethod
from pathlib import Path

from .transport import CommandResult, LocalTransport, SshTransport, Transport, TransportError


def shq(s: str) -> str:
    """Single-quote a path for sh: `'` -> `'\\''` (works on any POSIX shell)."""
    return "'" + s.replace("'", "'\\''") + "'"


class Workspace(ABC):
    def __init__(self, root: str | None = None, transport: Transport | None = None) -> None:
        self._own_dir = root is None
        self.root: Path = Path(root) if root else Path(tempfile.mkdtemp(prefix="clutch-"))
        self.root.mkdir(parents=True, exist_ok=True)
        self._transport = transport or LocalTransport(str(self.root))
        self._protected: set[Path] = set()

    def protect(self, path: Path) -> None:
        """Mark a file as invisible/unusable to the agent (e.g. the .clc project file)."""
        self._protected.add(Path(path).resolve())

    def is_protected(self, path: Path) -> bool:
        try:
            return Path(path).resolve() in self._protected
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

    def resolve(self, rel_path: str) -> Path:
        """Resolve a path to inside the workspace; raise ValueError on escape."""
        p = (self.root / rel_path).resolve()
        if not p.is_relative_to(self.root):
            raise ValueError(f"path escapes workspace: {rel_path!r}")
        return p

    def run(self, command: str, timeout: float) -> CommandResult:
        """Run a shell command in the workspace; transport-specific cwd handling."""
        return self._transport.run(command, timeout)

    @abstractmethod
    def read(self, path: str) -> str:
        """Return file contents; raise FileNotFoundError if missing."""

    @abstractmethod
    def write(self, path: str, content: str) -> None:
        """Create or overwrite a file (parents created as needed)."""

    @abstractmethod
    def list(self, path: str) -> list[str]:
        """Directory entries (dirs end with '/'), protected files excluded; raise NotADirectoryError."""

    @abstractmethod
    def append_line(self, path: str, line: str) -> None:
        """Append one line to a file (the remote .clc EventLog writer)."""

    def cleanup(self) -> None:
        if self._own_dir:
            import shutil

            shutil.rmtree(self.root, ignore_errors=True)


class LocalWorkspace(Workspace):
    def read(self, path: str) -> str:
        p = self.resolve(path)
        if not p.is_file():
            raise FileNotFoundError(path)
        return p.read_text(encoding="utf-8", errors="replace")

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


# ponytail: minimal sshd (dropbear/BusyBox on OpenWrt) drops the connection on a
# single exec request over ~8KB (measured on the test router: 7929 B ok, 9636 B
# died). Every remote write/append is chunked well below that, and run_command
# commands are capped so an oversized inline command fails cleanly instead of
# killing the tunnel (which would teach the model a hard limit).
_EXEC_CHUNK_BYTES = 3500
_EXEC_MAX_COMMAND_BYTES = 6000


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

    def run(self, command: str, timeout: float) -> CommandResult:
        cmd = f"cd {shq(str(self.root))} && {command}"
        # pre-check: an oversized exec command would make a minimal sshd drop the
        # connection. Fail cleanly up front (guide the model to write_file) rather
        # than let the tunnel die and teach the model a hard size limit.
        size = len(cmd.encode("utf-8"))
        if size > _EXEC_MAX_COMMAND_BYTES:
            raise TransportError(
                f"command too long to send over the remote transport ({size} bytes); "
                "write large content with write_file and run it"
            )
        return self._transport.run(cmd, timeout)

    def read(self, path: str) -> str:
        p = self.resolve(path)
        r = self._transport.run(f"cat {shq(str(p))}", 60.0)
        if r.code != 0:
            raise FileNotFoundError(str(p))
        return r.stdout

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
            r = self._transport.run(cmd, 60.0)
            if r.code != 0:
                raise OSError(f"write failed (exit {r.code}): {(r.stderr or r.stdout)[:300]}")

    def write(self, path: str, content: str) -> None:
        p = self.resolve(path)
        self._exec_append(p, content, first_op=">", add_trailing_nl=False, ensure_dir=True)

    def list(self, path: str) -> list[str]:
        p = self.resolve(path)
        # ls alone succeeds on a plain file; test -d first so a non-dir surfaces
        # as NotADirectoryError like LocalWorkspace.list
        r = self._transport.run(f"test -d {shq(str(p))} && ls -1AF {shq(str(p))}", 60.0)
        if r.code != 0:
            raise NotADirectoryError(str(p))
        out = []
        for entry in r.stdout.splitlines():
            if not entry:
                continue
            if entry.endswith("/"):  # ls -1AF marks dirs with a trailing /
                out.append(entry)
                continue
            name = entry[:-1] if entry[-1] in ("*", "@") else entry
            if self.is_protected(p / name):
                continue
            out.append(name)
        return sorted(out)

    def append_line(self, path: str, line: str) -> None:
        p = self.resolve(path)
        self._exec_append(p, line, first_op=">>", add_trailing_nl=True, ensure_dir=False)
