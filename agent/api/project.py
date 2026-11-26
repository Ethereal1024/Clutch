"""Project lifecycle over HTTP: create, open (with progress), and read history.

A new project is made in a directory the user picked (/api/project/new): the
.clc's parent is the session's working directory, so where a project lives is a
decision the user makes once, at creation, rather than something a scratch
directory can defer.

Opening a project replays its durable log; the NDJSON body of /api/project/open
is the same progress a local open prints, and `_history` hands the UI the window
the log resolved to.
"""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urlparse

from ..core.project_lock import ProjectOpenConflict
from ..events import event_to_json
from ..project import ProjectExists, create_project, open_project_lazy


class ProjectMixin:
    "Create, open, and read back a project."
    def _project_new(self) -> None:
        if self._state.busy:
            return self._json({"error": "a run is active; wait for it to finish"}, status=409)
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        dirname = (body.get("dir") or "").strip()
        name = (body.get("name") or "").strip()
        if not dirname or not name:
            return self._json({"error": "dir and name are required"}, status=400)
        try:
            project = create_project(Path(dirname) / name, name, model=self._cfg.model)
        except ProjectExists as e:
            # the name is taken by a file this create would have truncated: the
            # picker asked to MAKE a project, and one is already there — say
            # which, so the UI can point at opening it instead
            return self._json(
                {
                    # a sentence about the CONFLICT, like the code beside it (the
                    # UI prefixes its own "Failed to create project:"): the name
                    # is taken, and opening it is the way that answer becomes an
                    # answer
                    "error": f"{PurePosixPath(e.path).name} already exists — open it instead",
                    "code": "project_exists",
                },
                status=409,
            )
        except ProjectOpenConflict as e:
            # the file this create would write is being RUN by another window:
            # same answer as an open conflict, so the UI can say what happened
            payload: dict = {
                "error": "another window is running this project",
                "code": "project_open_conflict",
            }
            if e.owner is not None:
                payload["owner"] = e.owner
            return self._json(payload, status=409)
        except OSError as e:
            return self._json({"error": f"cannot create project: {e}"}, status=400)
        self._state.set_project(project)
        self._json(
            {
                "status": "ok",
                "project": str(project.path),
                "name": project.meta.name,
                "workdir": str(project.workdir),
            }
        )

    def _project_open(self) -> None:
        if self._state.busy:
            return self._json({"error": "a run is active; wait for it to finish"}, status=409)
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        path = (body.get("path") or "").strip()
        if not path:
            return self._json({"error": "path is required"}, status=400)
        full = self._project_path(path)
        if full.suffix != ".clc":
            return self._json({"error": "not a .clc project file"}, status=400)
        if not full.is_file():
            return self._json({"error": "not a .clc project file"}, status=400)
        read_only = bool(body.get("read_only")) or str(body.get("read_only", "")).lower() == "true"
        self._open_stream_start(full, read_only=read_only)

    def _open_stream_start(self, full: Path, read_only: bool = False) -> None:
        # build the workspace before index/load/append, so all three hit the same
        # root this open is about
        ws = self._state.build_workspace(str(full.parent))
        # NO LOCK IS TAKEN HERE. Opening a project is a read: the .clc is claimed
        # by the session that RUNS it (agent/base.py RunState.claim_run), not by
        # the windows looking at it, so an idle project opens everywhere. If
        # another window happens to be running it this very moment the open still
        # succeeds — the page then paints that run's stream read-only until it
        # ends (the claim watch loop in agent/server.py says when). Refusing the
        # open would have made the claim an OPEN claim, and an idle project would
        # belong to whoever happened to look at it first.
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def emit(obj) -> None:
            self.wfile.write((json.dumps(obj) + "\n").encode("utf-8"))
            self.wfile.flush()

        def on_progress(done: int, total: int) -> None:
            emit({"progress": {"done": done, "total": total}})

        try:
            project = open_project_lazy(full, on_progress=on_progress, workspace=ws, read_only=read_only)
        except (OSError, ValueError) as e:
            emit({"error": f"cannot open project: {e}"})
            return
        self._state.set_project(project, workspace=ws)
        # meta after the (single-pass, no-JSON) index scan: the header lives in the
        # same indexed read, so emitting it afterwards costs no extra fetch
        emit(
            {
                "meta": {
                    "project": str(full),
                    "name": project.meta.name,
                    "workdir": str(full.parent),
                    "read_only": project.read_only,
                }
            }
        )
        # lazy log: only the model window (since the newest compaction line) is
        # resident; "older" = event-region BYTES still on disk, paged via /api/history
        log = project.log
        pairs = log.items()
        emit({"count": len(pairs), "older": max(0, log.cpr_start())})
        for off, ev in pairs:
            emit({"offset": off, "event": json.loads(event_to_json(ev))})
        emit({"done": True})

    def _history(self) -> None:
        """Scroll-up paging for a lazily-opened project: PURE DISK read of the
        durable events in the byte range before ``before`` (relative offsets,
        exclusive, max ``limit`` bytes) and return them with their offsets. The
        UI prepends the page and trusts the response's server-side ``older``
        count (honest even after a reconnect dropped pages the UI already
        rendered). The page never enters the resident log: history browsing is
        decoupled from the model context (which is only the window since the
        newest compaction line).

        ``align=turn`` widens the page BACK to the task row that opens the turn the
        byte budget cut (log.aligned_start), so a page begins where a turn begins
        and the renderer is never handed a turn's middle without its head. ``older``
        is the widened start either way, so the next request pages from exactly
        where this one began."""
        qs = parse_qs(urlparse(self.path).query)
        try:
            before = int(qs.get("before", ["0"])[0])
            limit = min(max(int(qs.get("limit", ["262144"])[0]), 4096), 4 * 1024 * 1024)
        except ValueError:
            return self._json({"error": "bad query"}, status=400)
        align = qs.get("align", ["0"])[0] in ("1", "turn", "true")
        project = self._state.project
        log = project.log if project is not None else None
        if log is None:
            return self._json({"events": [], "older": 0})
        lo = max(0, before - limit)
        if align:
            lo = log.aligned_start(lo)
        pairs = log.read_page(lo, before)
        self._json(
            {
                "events": [{"offset": off, "event": json.loads(event_to_json(ev))} for off, ev in pairs],
                "older": max(0, lo),
            }
        )
