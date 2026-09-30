"""Project lifecycle over HTTP: create, open (with progress), and read history.

Opening a project replays its durable log; the NDJSON body of /api/project/open
is the same progress a local open prints, and `_history` hands the UI the window
the log resolved to.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ..core.project_lock import ProjectLock, ProjectOpenConflict
from ..events import event_to_json
from ..project import create_project, open_project_lazy


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
        ws = None
        try:
            if self._state.backend_mode == "ssh" and self._state.bridge_url:
                # _project_path: PurePosixPath lexical normalization — never the
                # host's Path (backslash re-separation on a Windows client)
                root = self._project_path(dirname)
                ws = self._state.build_workspace(str(root))
                project = create_project(root / name, name, model=self._cfg.model, workspace=ws)
            else:
                project = create_project(Path(dirname) / name, name, model=self._cfg.model)
        except ProjectOpenConflict:
            # the file this create would write is another window's project: same
            # answer as an open conflict, so the UI can say what actually happened
            return self._json(
                {"error": "project is open in another window", "code": "project_open_conflict"},
                status=409,
            )
        except OSError as e:
            return self._json({"error": f"cannot create project: {e}"}, status=400)
        self._state.set_project(project, workspace=ws)
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
        if self._state.backend_mode != "ssh":
            # remote paths don't exist on the local filesystem; the open itself
            # reports a missing remote file via workspace.read
            if not full.is_file():
                return self._json({"error": "not a .clc project file"}, status=400)
        read_only = bool(body.get("read_only")) or str(body.get("read_only", "")).lower() == "true"
        self._open_stream_start(full, read_only=read_only)

    def _open_stream_start(self, full: Path, read_only: bool = False) -> None:
        # build the workspace first (ssh mode -> RemoteWorkspace over the bridge),
        # so the lock and index/load/append all hit the same remote host
        ws = self._state.build_workspace(str(full.parent))
        # write lock: the window that opens a project for write is its only
        # writer. Conflict -> HTTP 409 + code so the UI can offer read-only
        # without parsing the NDJSON stream for the error line. The lock of the
        # project this open REPLACES is handed back by set_project (below), the
        # choke point where a project stops being the active one.
        lock = None
        if not read_only:
            lock = ProjectLock.acquire(str(full))
            if lock is None:
                return self._json(
                    {"error": "project is open in another window", "code": "project_open_conflict"},
                    status=409,
                )
        # stream the open as NDJSON so the UI can show real file-parse progress;
        # errors are reported inline as an {"error": ...} line
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
        except ProjectOpenConflict as e:
            if lock is not None:
                ProjectLock.release(lock)
            emit({"error": str(e), "code": e.code})
            return
        except (OSError, ValueError) as e:
            if lock is not None:
                ProjectLock.release(lock)
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
        newest compaction line)."""
        qs = parse_qs(urlparse(self.path).query)
        try:
            before = int(qs.get("before", ["0"])[0])
            limit = min(max(int(qs.get("limit", ["262144"])[0]), 4096), 4 * 1024 * 1024)
        except ValueError:
            return self._json({"error": "bad query"}, status=400)
        project = self._state.project
        log = project.log if project is not None else None
        if log is None:
            return self._json({"events": [], "older": 0})
        lo = max(0, before - limit)
        pairs = log.read_page(lo, before)
        self._json(
            {
                "events": [{"offset": off, "event": json.loads(event_to_json(ev))} for off, ev in pairs],
                "older": max(0, lo),
            }
        )
