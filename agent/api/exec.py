"""POST /api/exec: ONE tool call, run here, judged here (P3).

The loop lives in the host half (TODO.md D1/D3), so a tool call arrives as a
request instead of a Python frame: the host decided *which* call the model made
and what to show the page, and this endpoint answers the only question left —
what happened. Its answer is the one shape every producer of a tool result
already speaks (`tools/envelope.Envelope`): `{content, is_error, diff}`. The
host appends that as the `tool_result` durable event; it never learns the tool's
arguments' meaning, and this side never learns the conversation.

Permission lives here and only here (D3). The declarations say which policy word
a call is under (`registry.access` / `access_arg`) and `core.permission` judges
it — exactly what `agent/loop.py:_execute_tool` did before the loop moved. An
`ask` blocks THIS request until `POST /api/permission/respond` answers (or Stop
resolves it as denied); the prompt goes to the page as a `PermissionRequestEvent`
on the broadcaster, which is a UI event and never a `.clc` line (P3-4).

Two refusals are the request's shape, not the tool's: no project open and a
read-only project are answered 409 by every other writer of this session too
(`api/log.py`), because a call that mutates files must not run on a file this
process could not write. Everything else — unparsable arguments, an unknown
tool, a denied permission, a tool that threw — is a 200 with `is_error: true`:
that is what the model has to read, and turning it into an HTTP error would hide
it behind the host's own retry logic.

`POST /api/exec/cancel` is the same call's interrupt: a tool that runs a command
polls the event this endpoint registers, so Stop reaches the tree that is still
attached to it (a client that walks away from a socket cannot kill a process
group by leaving).
"""

from __future__ import annotations

import dataclasses
import threading

from ..core.parse import ParseError, parse_arguments
from ..core.permission import PermissionEvaluator, PermissionGate, PermissionRequired
from ..events import PermissionRequestEvent
from ..tools.envelope import Envelope


class ExecMixin:
    "The one-call execution endpoint: parse, judge, run, answer."
    # ---- API implementations ----

    def _exec(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        name = body.get("name")
        if not isinstance(name, str) or not name.strip():
            return self._json({"error": "name is required"}, status=400)
        tool_call_id = body.get("tool_call_id")
        if not isinstance(tool_call_id, str) or not tool_call_id.strip():
            # the id is the call's identity on both sides: the result it answers
            # is matched to it, and Stop reaches the running command through it.
            # A call without one could be neither answered nor interrupted, so it
            # is refused instead of run half-wired.
            return self._json({"error": "tool_call_id is required"}, status=400)
        arguments = body.get("arguments", "")
        if not isinstance(arguments, str):
            # the model's own wire form: the raw JSON text it produced. A dict
            # here would be a second shape for the same fact — and the permission
            # evaluator reads the TEXT (it splits a command, it does not trust a
            # pre-parsed tree).
            return self._json({"error": "arguments must be the model's raw JSON string"}, status=400)
        cfg = self._cfg
        mode = body.get("mode")
        if mode is not None:
            if mode not in ("chat", "work"):
                return self._json({"error": "mode must be chat or work"}, status=400)
            cfg = dataclasses.replace(cfg, mode=mode)

        project = self._state.project
        if project is None:
            return self._json({"error": "no project is open"}, status=409)
        if project.read_only:
            # the same answer api/log.py gives a writer: this process does not
            # hold the .clc's write lock, so it must not change the files the
            # .clc talks about either
            return self._json({"error": "project is read-only", "code": "read_only"}, status=409)

        workspace = self._state.workspace
        if workspace is None or workspace.root != project.workdir:
            # the workspace a run uses is claimed by the run (base.start_task);
            # a call that arrives between runs gets one built the same way
            workspace = self._state.build_workspace(str(project.workdir))
        workspace.protect(project.path)

        cancel = threading.Event()
        with self._state.lock:
            if tool_call_id in self._state.exec_cancels:
                return self._json(
                    {"error": "a call with this tool_call_id is already in flight"}, status=409
                )
            self._state.exec_cancels[tool_call_id] = cancel

        def _on_ask(request_id: str, tool: str, args_repr: str, reason: str) -> bool:
            # publish the prompt to whatever window watches THIS project; with
            # none, the gate denies instead of waiting for an answer that has
            # nowhere to be typed
            if self._broadcaster.count(str(project.path)) == 0:
                return False
            self._broadcaster.publish(
                PermissionRequestEvent(request_id=request_id, tool=tool, args_repr=args_repr, reason=reason)
            )
            return True

        gate = PermissionGate(
            evaluator=PermissionEvaluator(),
            on_ask=_on_ask,
            auto_allow=cfg.non_interactive,
            is_attached=lambda: self._broadcaster.count(str(project.path)) > 0,
            trust=lambda: self._state.trust_armed,
        )
        # a prompt may be answered while this request is blocked on it, and Stop
        # has to be able to resolve it: both find the gate through the state
        with self._state.lock:
            self._state.gates.append(gate)
            self._state.gate = gate
        try:
            return self._json(
                self._exec_call(project, workspace, cfg, gate, cancel, name, arguments, tool_call_id)
            )
        finally:
            with self._state.lock:
                self._state.exec_cancels.pop(tool_call_id, None)
                if gate in self._state.gates:
                    self._state.gates.remove(gate)
            if self._state.gate is gate:
                self._state.gate = None
            # a user-approved escape is scoped to the one call it was granted for
            workspace.clear_allowed()

    def _exec_call(
        self,
        project,
        workspace,
        cfg,
        gate: PermissionGate,
        cancel: threading.Event,
        name: str,
        arguments: str,
        tool_call_id: str,
    ) -> dict:
        try:
            args = parse_arguments(arguments)
        except ParseError as e:
            # the model's own JSON is malformed: it can fix that from the answer,
            # and nothing has been touched
            return self._answer(tool_call_id, Envelope(f"ERROR: {e.message}", error=True))
        registry = self._app.build_tools(project, cfg)
        try:
            # the policy comes from the tool's own declaration (D3): the loop is
            # gone, so this is the only place a call is judged
            gate.require(name, arguments, workspace, registry.access(name), registry.access_arg(name))
        except PermissionRequired as e:
            return self._answer(tool_call_id, Envelope(f"ERROR: {e.reason}", error=True))
        result = registry.execute(workspace, cfg, name, args, cancel=cancel)
        return self._answer(tool_call_id, result)

    @staticmethod
    def _answer(tool_call_id: str, result: Envelope) -> dict:
        return {
            "tool_call_id": tool_call_id,
            "content": result.content,
            "is_error": result.error,
            "diff": result.diff,
        }

    def _exec_cancel(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        tool_call_id = body.get("tool_call_id")
        if not isinstance(tool_call_id, str) or not tool_call_id.strip():
            return self._json({"error": "tool_call_id is required"}, status=400)
        with self._state.lock:
            cancel = self._state.exec_cancels.get(tool_call_id)
        if cancel is None:
            # not a silent success: the caller believed a call was running, and
            # the honest answer to "stop it" is that there is nothing to stop
            return self._json({"error": "no call in flight with this tool_call_id"}, status=404)
        cancel.set()
        self._json({"status": "cancelling"})
