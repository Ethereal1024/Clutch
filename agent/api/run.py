"""POST /api/run and /api/stop: the single run slot.

One run at a time. The run itself is assembled by the app (`HttpAgentServer`),
so this module only decides whether the request may start, hands the task over,
and flips the cancel flag the loop checks between turns.
"""

from __future__ import annotations

import dataclasses
import sys
import threading

from ..core.project_lock import ProjectOpenConflict
from ..events import FinalEvent, PermissionRequestEvent, StateUpdateEvent
from ..project import open_project_lazy


class RunMixin:
    "The one run slot: start a run, cancel a run."
    # ---- API implementations ----

    def _run(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        task = (body.get("task") or "").strip()
        config = self._cfg
        mode = body.get("mode")
        if mode in ("chat", "work"):
            config = dataclasses.replace(config, mode=mode)

        if not task:
            return self._json({"error": "task is required"}, status=400)

        project = self._state.project
        req_project = (body.get("project") or "").strip()
        if req_project and (project is None or str(project.path) != req_project):
            if self._state.busy:
                # never replace (and thereby unlock) the active project while a
                # run is using it: the run appends to that .clc's log, so its
                # write lock has to stay held for as long as it lasts
                return self._json({"error": "a run is already active"}, status=409)
            # a different window's project: switch the active project to this
            # window's file so each UI window's runs append to its own .clc
            full = self._project_path(req_project)
            if full.suffix != ".clc" or (self._state.backend_mode != "ssh" and not full.is_file()):
                return self._json({"error": f"cannot open project: {req_project}"}, status=400)
            try:
                ws = self._state.build_workspace(str(full.parent))
                project = open_project_lazy(full, workspace=ws)
                self._state.set_project(project, workspace=ws)
            except ProjectOpenConflict:
                return self._json(
                    {"error": "project is open in another window", "code": "project_open_conflict"},
                    status=409,
                )
            except (OSError, ValueError) as e:
                return self._json({"error": f"cannot open project: {e}"}, status=500)
        if project is None:
            return self._json({"error": "no project open; create or open one first"}, status=400)
        if project.read_only:
            return self._json(
                {"error": "project opened read-only; close the other window first"}, status=409
            )

        def _on_ask(request_id: str, tool: str, args_repr: str, reason: str) -> bool:
            # publish the permission request to the UI; with no SSE subscriber
            # the gate denies instead of blocking forever
            if self._broadcaster.count() == 0:
                return False
            self._broadcaster.publish(
                PermissionRequestEvent(request_id=request_id, tool=tool, args_repr=args_repr, reason=reason)
            )
            return True

        try:
            agent = self._app.start_task(task, project, on_ask=_on_ask, cancel=None, config=config)
        except RuntimeError as e:
            # missing API key: an anticipated, user-facing condition
            return self._json({"error": f"LLM init failed: {e}"}, status=500)
        if agent is None:
            return self._json({"error": "a run is already active"}, status=409)
        self._state.gate = agent.gate
        # tag the active run with its project so SSE subscribers on other
        # projects can filter it out of their live stream
        self._state.run_project = str(project.path)

        def _worker() -> None:
            # run() emits a graceful error final for anticipated AgentError
            # failures; anything else (e.g. the SSH tunnel dying under a degraded
            # backend) must surface as an error final instead of a silent idle.
            try:
                agent.run(task)
            except Exception as e:  # noqa: BLE001 -- last-resort user-facing final
                print(f"[clutch] run crashed: {e}", file=sys.stderr)
                try:
                    self._broadcaster.publish(FinalEvent(status="error", summary=f"run crashed: {e}"))
                    self._broadcaster.publish(StateUpdateEvent(value="error"))
                except Exception:  # noqa: BLE001
                    pass
            finally:
                self._state.finish()

        threading.Thread(target=_worker, daemon=True).start()
        self._json(
            {
                "status": "started",
                "workspace": str(agent.workspace.root),
                "project": str(project.path),
            }
        )

    def _stop(self) -> None:
        if self._state.cancel:
            self._state.cancel.set()
        # a run may be blocked on a permission prompt (gate.require waits): Stop
        # must unblock it, otherwise the agent stays stuck until the 60s timeout
        gate = self._state.gate
        if gate is not None:
            for rid in list(gate.pending_ids()):
                gate.resolve(rid, False)
        self._json({"status": "cancelling"})
