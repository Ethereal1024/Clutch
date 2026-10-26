"""The file-side API: the working tree and the directory browser.

Every read and write goes through the Workspace abstraction, so a remote (SSH
bridge) project works unchanged: the caller only ever sees paths and bytes.
"""

from __future__ import annotations

import posixpath
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urlparse

from .. import browsing


class WorkspaceMixin:
    "The workspace and the directory browser."
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

    def _workspace_checkpoints(self) -> None:
        """Which tasks a whole-task rollback can be offered for.

        The list is the workspace journal's anchors — the log offsets under
        which file mutations were recorded, one per task that changed something
        (Workspace.begin_turn / record_mutation). The UI asks for it when a
        window opens and when a task ends, because the journal lives in THIS
        process: a journal of past tasks is not something the transcript can be
        read back for, and the anchor is the offset the UI already has on each
        rendered user message.

        A task that changed nothing is absent on purpose — "roll back to here"
        would restore exactly the state the workspace is already in.
        """
        ws = self._state.workspace
        self._json({"anchors": ws.rollback_anchors() if ws is not None else []})

    def _workspace_rollback(self) -> None:
        """Roll the workspace back to a sent task: undo every file mutation
        recorded at or after that task's log offset, newest first.

        This is the long-press / right-click action on a user message: it
        deletes the files the later tasks created and restores the content they
        overwrote, so the working tree is what it was before that message was
        sent. The .clc is deliberately NOT truncated — the transcript keeps the
        record of what ran, and undo/redo of CONVERSATION is not this endpoint's
        job. Refused while a run is live (409): the run is writing those files
        right now, and rolling back beneath it would have the journal record the
        restored content as another mutation, blurring where the task started.
        """
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        offset = body.get("offset")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            return self._json({"error": "offset (a non-negative integer) is required"}, status=400)
        ws = self._state.workspace
        if ws is None:
            return self._json({"error": "no workspace open"}, status=400)
        if self._state.busy:
            return self._json({"error": "a run is active; stop it before rolling back"}, status=409)
        project = self._state.project
        if project is not None and project.read_only:
            return self._json(
                {"error": "project opened read-only; close the other window first"}, status=409
            )
        report = ws.rollback_from(offset)
        if report is None:
            return self._json({"error": "no recorded changes for that task"}, status=404)
        self._json(
            {
                "status": "ok",
                "restored": report["restored"],
                "deleted": report["deleted"],
                "count": len(report["restored"]) + len(report["deleted"]),
            }
        )

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
