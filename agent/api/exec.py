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
`ask` blocks THIS request until `POST /api/permission/respond` answers, or until
`POST /api/exec/cancel` for this call's id resolves it as denied (that is what
the page's Stop button sends); the prompt goes to the page as a
`PermissionRequestEvent` on the broadcaster, which is a UI event and never a
`.clc` line (P3-4).

Two refusals are the request's shape, not the tool's: no project open and a
read-only project are answered 409 by every other writer of this session too
(`api/log.py`), because a call that mutates files must not run on a file this
process could not write. Everything else — unparsable arguments, an unknown
tool, a denied permission, a tool that threw — is a 200 with `is_error: true`:
that is what the model has to read, and turning it into an HTTP error would hide
it behind the host's own retry logic.

A call that arrives AGAIN — the same `tool_call_id` with the same `name` and the
same `arguments` — is the same call, not a new one. The endpoint remembers the
last `DONE_KEEP` answers (`state.exec_answered`) and hands the repeat the answer
it already gave, without running the tool: the caller chose the id, so one id is
one side effect, whichever layer replayed the request. The repeat is answered 200
with the original envelope, deliberately NOT a 409 — a refusal would be recorded
as a failed call and the model would make the same edit again, which is the
duplicate this exists to stop. A reused id with DIFFERENT arguments is a client
bug, not a replay, so that one runs: the memo only claims to recognise the same
call.

`POST /api/exec/cancel` is the same call's interrupt: a tool that runs a command
polls the event this endpoint registers, so Stop reaches the tree that is still
attached to it (a client that walks away from a socket cannot kill a process
group by leaving). A call that is still waiting to be allowed is not running
yet, so cancelling it denies the prompt it is blocked on — Stop is not an
approval, and it must end the wait rather than leave a dialog nobody will answer.
"""

from __future__ import annotations

import dataclasses
import threading
from collections.abc import Callable

from ..core.parse import ParseError, parse_arguments
from ..core.permission import PermissionEvaluator, PermissionGate, PermissionRequired
from ..events import PermissionRequestEvent
from ..tools.envelope import Envelope

# How many answered calls this session remembers, newest kept. The window in
# which a duplicate can arrive is one request's flight, so this only has to cover
# the calls a single turn (or a retry of it) can produce — and it must not grow
# with a session that runs for hours.
DONE_KEEP = 64


class _CallCancel(threading.Event):
    """One call's interrupt, with the one thing a bare Event cannot do.

    A call is interruptible in two places: the command it started polls this
    flag, and the permission prompt it is blocked on waits on the ask's own
    Event — a different object, owned by the gate. Setting the flag alone would
    reach a running command but not a call that never got that far, so `deny`
    is the hook that answers this call's pending prompt while `set()` still does
    what every `threading.Event` does. It is attached once the gate exists and
    is a no-op before that (the flag is registered before the gate is built, so
    a cancel cannot slip in between and be lost).
    """

    deny: Callable[[], None] | None = None

    def set(self) -> None:
        if self.deny is not None:
            self.deny()  # idempotent: resolve() ignores an id already answered
        super().set()


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
        refusal = self._write_refusal(project)
        if refusal is not None:
            # a tool call changes the files the .clc talks about, so it needs
            # the same claim the .clc's own lines need: a session that is not
            # running the project would be executing behind the back of the one
            # that is, and its results would arrive in a log it cannot append to
            return self._json(refusal, status=409)

        workspace = self._state.workspace
        if workspace is None or workspace.root != project.workdir:
            # the workspace a run uses is built on demand (state.build_workspace):
            # nothing claims one up front any more, so a call arriving between two
            # turns gets one built the same way a call inside a turn does
            workspace = self._state.build_workspace(str(project.workdir))
        workspace.protect(project.path)

        cancel = _CallCancel()
        with self._state.lock:
            if tool_call_id in self._state.exec_cancels:
                return self._json(
                    {"error": "a call with this tool_call_id is already in flight"}, status=409
                )
            answered = self._answered(tool_call_id, name, arguments)
            if answered is None:
                self._state.exec_cancels[tool_call_id] = cancel
        if answered is not None:
            # the answer goes out after the lock is released: writing to the
            # socket is the one thing here that can block, and the session's
            # bookkeeping is not the socket's
            return self._json(answered)

        def _on_ask(request_id: str, tool: str, args_repr: str, reason: str) -> bool:
            # publish the prompt to whatever window watches THIS project; with
            # none, the gate denies instead of waiting for an answer that has
            # nowhere to be typed
            if self._broadcaster.count(str(project.path)) == 0:
                return False
            self._broadcaster.publish(
                PermissionRequestEvent(request_id=request_id, tool=tool, args_repr=args_repr, reason=reason),
                # narrowed to the project this call belongs to: the gate above
                # only counts the windows that would see it, so the prompt must
                # only reach them. With the host driving the loop (P1-5) there
                # is no run_project for _sse to filter on, and an unfiltered
                # publish would put this ask in every window.
                project=str(project.path),
            )
            return True

        gate = PermissionGate(
            evaluator=PermissionEvaluator(),
            on_ask=_on_ask,
            auto_allow=cfg.non_interactive,
            is_attached=lambda: self._broadcaster.count(str(project.path)) > 0,
            trust=lambda: self._state.trust_armed,
        )
        # a prompt may be answered while this request is blocked on it (the
        # responder walks state.gates), and Stop has to be able to resolve it.
        # Cancelling this call answers its own prompt — and only its own: the
        # hook reads this gate, not every live one.
        cancel.deny = lambda: [gate.resolve(rid, False) for rid in gate.pending_ids()]
        with self._state.lock:
            self._state.gates.append(gate)
        answer: dict | None = None
        try:
            answer = self._exec_call(project, workspace, cfg, gate, cancel, name, arguments, tool_call_id)
        finally:
            # the memo is written in the SAME lock that releases the in-flight
            # entry, and before the answer leaves this process: a repeat sees
            # either "in flight" (409) or "already answered" (the memo), never a
            # gap in which the tool would run a second time
            with self._state.lock:
                self._state.exec_cancels.pop(tool_call_id, None)
                if answer is not None:
                    self._remember_answer(tool_call_id, name, arguments, answer)
                if gate in self._state.gates:
                    self._state.gates.remove(gate)
            # a user-approved escape is scoped to the one call it was granted for
            workspace.clear_allowed()
        assert answer is not None  # _exec_call answers or raises; nothing else gets here
        return self._json(answer)

    def _answered(self, tool_call_id: str, name: str, arguments: str) -> dict | None:
        """The answer this exact call already got, or None if it has not run.

        "Exact" is the whole point: the id alone would let a caller that reuses
        an id for a different call be handed the old answer — a silent lie about
        work that never happened. Same id, same name, same raw arguments is the
        same request. The caller holds state.lock.
        """
        done = self._state.exec_answered.get(tool_call_id)
        if done is None or done[0] != name or done[1] != arguments:
            return None
        return done[2]

    def _remember_answer(self, tool_call_id: str, name: str, arguments: str, answer: dict) -> None:
        """Remember what this id was answered, so a second arrival is answered, not run.

        A bounded ring (DONE_KEEP): re-inserting moves the id to the newest end,
        so eviction is by the time it was answered, not by when it was first
        seen. The caller holds state.lock, next to the pop of the in-flight
        entry, so the two are one visible state change.
        """
        done = self._state.exec_answered
        done.pop(tool_call_id, None)
        done[tool_call_id] = (name, arguments, answer)
        while len(done) > DONE_KEEP:
            done.pop(next(iter(done)))

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
        # this also denies the prompt the call may be waiting on (see
        # _CallCancel): the one id answers "stop this call" wherever it is
        cancel.set()
        self._json({"status": "cancelling"})
