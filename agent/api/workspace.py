"""The file-side API: the working tree, the directory browser, and the .clc bytes.

Every read and write goes through the Workspace abstraction, so a remote (SSH
bridge) project works unchanged: the caller only ever sees paths and bytes.
"""

from __future__ import annotations

import base64
import binascii
import posixpath
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urlparse

from .. import browsing
from ..project import Project
from ..tools.workspace import Workspace


class WorkspaceMixin:
    "The workspace, the directory browser, and the .clc byte service."
    def _project_path(self, raw: str) -> Path:
        """Normalize a client-supplied .clc path WITHOUT local filesystem
        semantics in ssh mode: the path lives on the REMOTE host, and
        Path.resolve() here would rewrite it with the app host's view of the
        world (/home -> /System/Volumes/Data/home on macOS autofs) — and a
        Windows host's Path would even re-separator it with backslashes.
        ssh mode therefore normalizes lexically in the PurePosixPath flavor;
        Local mode keeps the OS realpath — it feeds the is_file() existence
        check. Ssh mode leaves existence to the remote open/read itself."""
        if self._state.backend_mode == "ssh":
            return PurePosixPath(posixpath.normpath(raw.replace("\\", "/")))
        return Path(raw).resolve()

    def _workspace_tree(self) -> None:
        qs = parse_qs(urlparse(self.path).query)
        expanded = qs.get("expanded", [])
        show_hidden = qs.get("hidden", ["0"])[0] == "1"
        sb = self._state.workspace
        if sb is None:
            return self._json({"tree": [], "root": None})
        self._json({"tree": browsing.tree(sb, expanded, show_hidden), "root": str(sb.root)})

    def _workspace_revert(self) -> None:
        """User-side undo: restore the last snapshot of a file in the workspace
        (the write_file/edit_file tools record a snapshot before every overwrite).
        Backs the UI's "↶ undo" button on a change result."""
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        path = (body.get("path") or "").strip()
        ws = self._state.workspace
        if ws is None or not path:
            return self._json({"error": "no workspace open"}, status=400)
        try:
            p = ws.resolve(path)
        except ValueError as e:
            return self._json({"error": str(e)}, status=400)
        if ws.is_protected(p):
            return self._json({"error": "protected file"}, status=400)
        if ws.restore(p) is None:
            return self._json({"error": "no snapshot to restore"}, status=404)
        self._json({"status": "ok", "path": str(p)})

    # ---- .clc content service ----
    # Byte-level access to the ACTIVE project's .clc for decoupled tool modules
    # (clutch-memory and friends run as one-shot scripts; they must not import
    # host code). All I/O routes through the workspace abstraction, so remote
    # (SSH bridge) projects work unchanged — the module only ever sees bytes.
    # The server binds locally, so no auth. Contract:
    #   GET  /api/clc?lo=N&hi=N      -> {"size", "b64"}   (b64 = raw bytes [lo, hi))
    #   POST /api/clc/append {line}  -> {"offset", "size"} (offset = write position,
    #                                   handed back so a caller updating an index
    #                                   never has to re-stat the file)
    #   POST /api/clc/patch {offset, b64} -> {"size"}      (in-place only)
    # Writes are serialized by state.clc_lock and bookkept into the event log
    # (note_bytes_written) so the lazy log's window math stays exact — the caller
    # never worries about either.

    def _clc_target(self) -> tuple[Project, Workspace] | None:
        """Active project + workspace, or a 400 response when none is open."""
        project = self._state.project
        ws = self._state.workspace
        if project is None or ws is None:
            self._json({"error": "no project open; create or open one first"}, status=400)
            return None
        return project, ws

    def _clc_read(self) -> None:
        target = self._clc_target()
        if target is None:
            return
        project, ws = target
        qs = parse_qs(urlparse(self.path).query)
        path = str(project.path)
        try:
            size = ws.size(path)
            lo = int((qs.get("lo") or ["0"])[0])
            hi = int((qs.get("hi") or [str(size)])[0])
        except (OSError, ValueError):
            return self._json({"error": "bad query"}, status=400)
        if lo < 0 or hi < lo:
            return self._json({"error": "invalid range"}, status=400)
        lo, hi = min(lo, size), min(hi, size)
        try:
            data = ws.read_range(path, lo, hi) if hi > lo else b""
        except OSError as e:
            return self._json({"error": str(e)}, status=500)
        self._json({"size": size, "b64": base64.b64encode(data).decode("ascii")})

    def _clc_append(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        line = body.get("line")
        if not isinstance(line, str) or "\n" in line or "\r" in line:
            return self._json({"error": "line must be one line (no newline characters)"}, status=400)
        target = self._clc_target()
        if target is None:
            return
        project, ws = target
        if project.read_only:
            return self._json({"error": "project opened read-only; close the other window first"}, status=409)
        path = str(project.path)
        n = len(line.encode("utf-8")) + 1  # the writer appends exactly one \n
        with self._state.clc_lock:
            try:
                off = ws.size(path)  # pre-append size == this line's write offset
                ws.append_line(path, line)
                total = ws.size(path)
            except OSError as e:
                return self._json({"error": str(e)}, status=500)
            project.log.note_bytes_written(n)
        self._json({"offset": off, "size": total})

    def _clc_patch(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        offset = body.get("offset")
        b64 = body.get("b64")
        if not isinstance(offset, int) or isinstance(offset, bool) or not isinstance(b64, str):
            return self._json({"error": "offset (int) and b64 (string) are required"}, status=400)
        target = self._clc_target()
        if target is None:
            return
        project, ws = target
        if project.read_only:
            return self._json({"error": "project opened read-only; close the other window first"}, status=409)
        try:
            data = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            return self._json({"error": "b64 is not valid base64"}, status=400)
        path = str(project.path)
        with self._state.clc_lock:
            try:
                size = ws.size(path)
            except OSError as e:
                return self._json({"error": str(e)}, status=500)
            if offset < 0 or offset + len(data) > size:
                return self._json({"error": "patch must stay in place (would grow the file)"}, status=400)
            try:
                ws.write_at(path, offset, data)
            except OSError as e:
                return self._json({"error": str(e)}, status=500)
        self._json({"size": size})


    def _fs_list(self) -> None:
        """Server-side directory browser (the UI picks projects from here).

        One level, starting at the server user's home (or the SSH remote's home in
        degradation mode). Reachable only via the local bind or the SSH tunnel, so
        no auth is needed. The payload contract and both transports live in
        agent.browsing so the local and remote shapes cannot drift.
        """
        qs = parse_qs(urlparse(self.path).query)
        raw = (qs.get("path") or [""])[0]
        show_hidden = qs.get("hidden", ["0"])[0] == "1"
        self._json(browsing.fs_list(self._state, raw, show_hidden))
