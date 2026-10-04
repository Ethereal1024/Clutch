"""Gate detachment check: a prompt nobody can answer must not wedge the run.

Run: uv run python -m tests.gate_detach_test

The wedge this guards against (observed live): a permission ask is published to
a UI whose connection then closes wrongly; PermissionGate.require waits in
ev.wait() forever because there was no timeout — the run never finishes, the
supervisor never reaps the session ("has a run in flight"), and the project's
write lock (one flock per .clc) outlives every frontend, leaving the file
read-only for every other window. The gate now watches whether a UI that can
answer is still attached and denies after a continuous detachment — but a brief
SSE gap (EventSource retry, tunnel redial) must NOT deny a prompt the user is
actually answering.
"""

from __future__ import annotations

import sys
import tempfile
import threading
import time
from pathlib import Path

from agent.base import Broadcaster
from agent.config import Config
from agent.core.permission import (
    PermissionEvaluator,
    PermissionGate,
    PermissionRequired,
)
from agent.project import ProjectLock, create_project
from agent.server import HttpAgentServer, RunState
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check


def _require_in_thread(gate, ws, out: dict) -> threading.Thread:
    def _run() -> None:
        try:
            # "rm ..." matches a DEFAULT_RULES ask rule (like selfcheck 9c):
            # an innocuous "echo hi" would be auto-allowed and never reach the gate
            gate.require("run_command", '{"command": "rm -rf /tmp/x"}', ws, "command")
            out["ok"] = True
        except PermissionRequired as e:
            out["err"] = e.reason

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def _gone_ui_denies_the_ask(tmp: str) -> None:
    # the observed wedge: the ask IS published (on_ask True), then the UI's
    # connection is gone for good. The gate must end the run instead of holding
    # it — and with it the project's write lock — forever.
    ws = LocalWorkspace(tmp)
    gate = PermissionGate(
        evaluator=PermissionEvaluator(),
        on_ask=lambda *a: True,
        is_attached=lambda: False,
        detach_grace_s=0.2,
        attach_poll_s=0.01,
    )
    out: dict = {}
    t = _require_in_thread(gate, ws, out)
    t.join(timeout=5)
    check(not t.is_alive(), "a prompt nobody can answer ends the run (no eternal wait)")
    check(
        "no user interface connected" in out.get("err", ""),
        f"gone UI denies with a clear reason ({out.get('err')!r})",
    )
    check(len(gate.pending_ids()) == 0, "the denied ask leaves no pending entry")


def _transient_gap_does_not_deny(tmp: str) -> None:
    # EventSource retry / tunnel redial: the stream blips out for well under the
    # grace window and comes back while the user is still answering. The prompt
    # must survive the gap and resolve normally.
    ws = LocalWorkspace(tmp)
    attached_at = time.time() + 0.06  # a short gap right at the start

    def _attached() -> bool:
        return time.time() >= attached_at

    gate = PermissionGate(
        evaluator=PermissionEvaluator(),
        on_ask=lambda *a: True,
        is_attached=_attached,
        detach_grace_s=0.25,  # gap (~0.06s) < grace -> must NOT deny
        attach_poll_s=0.01,
    )
    out: dict = {}
    t = _require_in_thread(gate, ws, out)

    def _user_answers() -> None:
        for rid in gate.pending_ids():
            gate.resolve(rid, True)

    timer = threading.Timer(0.35, _user_answers)  # the user answers after the gap
    timer.start()
    t.join(timeout=5)
    timer.join()
    check(not t.is_alive(), "the prompt survived the stream gap")
    check(out.get("ok"), f"a brief detach does not deny a live prompt ({out.get('err')!r})")


def _attached_prompt_still_waits_for_the_user(tmp: str) -> None:
    # the fix must not weaken the normal case: with a UI attached, the gate
    # waits for the USER's answer and a denial still propagates.
    ws = LocalWorkspace(tmp)
    gate = PermissionGate(
        evaluator=PermissionEvaluator(),
        on_ask=lambda *a: True,
        is_attached=lambda: True,
        detach_grace_s=0.2,
        attach_poll_s=0.01,
    )
    out: dict = {}
    t = _require_in_thread(gate, ws, out)

    def _user_denies() -> None:
        for rid in gate.pending_ids():
            gate.resolve(rid, False)

    timer = threading.Timer(0.15, _user_denies)
    timer.start()
    t.join(timeout=5)
    timer.join()
    check(not t.is_alive(), "an attached prompt ends with the user's answer")
    check(out.get("err") == "denied by user", f"denial still reaches the run ({out!r})")


def _count_is_project_scoped() -> None:
    # "is a UI attached" must count only the streams that would actually SEE
    # this project's events: a window on another project cannot answer its prompt.
    b = Broadcaster()
    q_all = b.subscribe()
    q_a = b.subscribe("a")
    check(b.count() == 2, "count() lists every live stream")
    check(b.count("a") == 2, "a project's own watcher + unfiltered streams can answer")
    check(b.count("b") == 1, "only the unfiltered stream can answer for another project")
    b.unsubscribe(q_all)
    check(b.count("a") == 1, "project A still watched after the unfiltered stream leaves")
    check(b.count("b") == 0, "project B has nobody left to answer")
    b.unsubscribe(q_a)
    check(b.count("a") == 0, "all streams gone")
    check(b.count() == 0, "no phantom subscribers")


def _start_task_wires_the_check() -> None:
    # end to end: the gate a real run gets counts subscribers of THAT project.
    broadcaster = Broadcaster()
    state = RunState()
    state.api_key = "sk-fake"  # build_llm only constructs a client; nothing dials out
    factory = HttpAgentServer(Config(port=0, base_url="http://127.0.0.1:1/v1", model="m"), broadcaster, state)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        project = create_project(tmp / "w.clc", "w", "prov/model")
        try:
            run = factory.start_task("t", project)
            check(run is not None, "start_task assembled the run")
            attached = run.gate.is_attached
            check(not attached(), "no subscriber -> the gate sees no one to answer")

            q = broadcaster.subscribe(str(project.path))
            check(attached(), "this project's watcher makes the prompt answerable")
            broadcaster.unsubscribe(q)
            check(not attached(), "watcher gone -> unanswerable again")

            q_other = broadcaster.subscribe("some-other-project.clc")
            check(
                not attached(),
                "a window on ANOTHER project cannot answer this project's prompt",
            )
            broadcaster.unsubscribe(q_other)

            q_all = broadcaster.subscribe()
            check(attached(), "an unfiltered stream sees every project's prompts")
            broadcaster.unsubscribe(q_all)
            check(not attached(), "back to nobody")
        finally:
            ProjectLock.release(project.lock)
            project.lock = None


def main() -> int:
    with tempfile.TemporaryDirectory() as wtmp:
        _gone_ui_denies_the_ask(wtmp)
        print("ok - a gone UI denies the ask instead of wedging the run")
        _transient_gap_does_not_deny(wtmp)
        print("ok - a transient stream gap does not deny a live prompt")
        _attached_prompt_still_waits_for_the_user(wtmp)
        print("ok - an attached prompt still waits for the user's answer")
    _count_is_project_scoped()
    print("ok - Broadcaster.count is project-scoped")
    _start_task_wires_the_check()
    print("ok - start_task wires the gate to this project's subscribers")
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
