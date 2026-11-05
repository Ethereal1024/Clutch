"""POST /api/exec: one tool call, run on this machine, judged by this machine (P3).

Run: .venv/bin/python -m tests.exec_api_test

The loop moved to the host half (TODO.md D1), so a tool call now arrives as an
HTTP request instead of a Python frame. What this suite pins:

  1. The answer is the ONE shape every tool result already has —
     {tool_call_id, content, is_error, diff} — so the host can append it as the
     `tool_result` durable event without knowing anything about tools.
  2. The request's own shape is refused, not guessed: no name, no tool_call_id
     (an unanswered, uninterruptible call), non-string arguments (the model's
     raw JSON text is the form the policy reads), an unknown mode, no project
     (409), a read-only project (409).
  3. Everything a TOOL did is a 200 with is_error: unparsable arguments, an
     unknown tool, a refused permission, a command that failed. Turning those
     into HTTP errors would hide the model's own mistake behind the host's
     retry logic.
  4. Permission is judged HERE and only here (D3): an `ask` publishes a
     PermissionRequestEvent to the watching window, blocks THIS request until
     POST /api/permission/respond answers it, and — with no window watching —
     denies immediately instead of waiting for an answer that has nowhere to be
     typed. A prompt is never a .clc line (P3-4).
  5. POST /api/exec/cancel interrupts the CALL's own command: Stop has to reach
     a process that is still running on this machine, because a client that
     walks away from a socket cannot kill a process group by leaving.
  6. Nothing leaks: the call's cancel entry and gate are gone when the request
     answers, whatever the answer was. A gate left behind is a session that can
     never be answered again.
"""

from __future__ import annotations

import json
import queue
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from agent.base import Broadcaster, RunState
from agent.config import Config
from agent.events import PermissionRequestEvent
from agent.project import create_project, open_project_lazy
from agent.server import build
from tests.testsupport import check, http_post


def open_server(tmp: Path, name: str, read_only: bool = False):
    """A real server (routing + handler wiring) with one .clc open."""
    path = tmp / name / f"{name}.clc"
    project = create_project(path, name, model="fake-model")
    cfg = Config(host="127.0.0.1", port=0)
    state = RunState()
    broadcaster = Broadcaster()
    srv = build(cfg, broadcaster, state)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    if read_only:
        project = open_project_lazy(path, workspace=None, read_only=True)
        check(project.read_only, "the read-only fixture really is read-only")
    state.set_project(project)
    return f"http://127.0.0.1:{cfg.port}", broadcaster, state, project, srv


def post_raw(url: str, data: bytes) -> tuple[int, str]:
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def exec_call(base: str, body: dict) -> tuple[int, dict]:
    status, text = http_post(f"{base}/api/exec", body)
    try:
        return status, json.loads(text)
    except json.JSONDecodeError:  # pragma: no cover - a non-JSON answer is a bug
        check(False, f"/api/exec answers JSON (got {status}: {text[:200]})")
        raise


def in_thread(fn):
    box: dict[str, object] = {}

    def run() -> None:
        try:
            box["value"] = fn()
        except BaseException as e:  # noqa: BLE001 -- surfaced by the joiner
            box["error"] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t, box


def next_event(q: queue.Queue, seconds: float = 5.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            return q.get(timeout=0.1)
        except queue.Empty:
            continue
    check(False, "a permission prompt was published to the watching window")
    raise AssertionError


def body_of(status_text: tuple[int, str]) -> dict:
    return json.loads(status_text[1])


# ---- 1. the request's own shape -------------------------------------------------


def shape_check(tmp: Path) -> None:
    base, broadcaster, state, project, _srv = open_server(tmp, "shape")
    url = f"{base}/api/exec"

    status, body = post_raw(url, b"not json at all")
    check(status == 400, "an unparsable body is a 400, not a tool result")
    check("bad json body" in body, "the 400 says what was wrong")

    status, body = exec_call(base, {"arguments": "{}", "tool_call_id": "c1"})
    check(status == 400 and "name is required" in json.dumps(body), "a call with no name is refused")

    status, body = exec_call(base, {"name": "   ", "arguments": "{}", "tool_call_id": "c1"})
    check(status == 400, "a blank name is no name")

    status, body = exec_call(base, {"name": "run_command", "arguments": "{}"})
    check(
        status == 400 and "tool_call_id" in json.dumps(body),
        "a call with no tool_call_id is refused: it could neither be answered nor stopped",
    )

    status, body = exec_call(base, {"name": "run_command", "arguments": {"command": "echo hi"}, "tool_call_id": "c1"})
    check(
        status == 400 and "raw JSON string" in json.dumps(body),
        "arguments must be the model's raw JSON text — never a second shape for the same fact",
    )

    status, body = exec_call(
        base, {"name": "run_command", "arguments": "{}", "tool_call_id": "c1", "mode": "auto"}
    )
    check(status == 400 and "mode" in json.dumps(body), "an unknown mode is refused, not ignored")

    # nothing above created a gate or a cancel entry: a refused request must not
    # leave the session holding a prompt nobody asked
    check(state.gate is None and state.gates == [], "a refused request leaves no gate behind")
    check(state.exec_cancels == {}, "a refused request leaves no cancel entry behind")
    check(broadcaster.count(str(project.path)) == 0, "no prompt was published for a refused request")

    # no project open: the same 409 its log writer gives
    empty_path = tmp / "shape" / "empty.clc"
    create_project(empty_path, "empty", model="fake-model")
    cfg = Config(host="127.0.0.1", port=0)
    empty_state = RunState()
    empty_srv = build(cfg, Broadcaster(), empty_state)
    threading.Thread(target=empty_srv.serve_forever, daemon=True).start()
    empty_base = f"http://127.0.0.1:{cfg.port}"
    status, body = exec_call(empty_base, {"name": "run_command", "arguments": "{}", "tool_call_id": "c1"})
    check(
        status == 409 and "no project is open" in json.dumps(body),
        "/api/exec with no project is a 409, answered before any tool is looked at",
    )


# ---- 2. what a call answers (200 + envelope) ------------------------------------


def envelope_check(tmp: Path) -> None:
    base, _bc, state, project, _srv = open_server(tmp, "envelope")

    status, body = exec_call(base, {"name": "no_such_tool", "arguments": "{}", "tool_call_id": "c1"})
    check(status == 200 and body["is_error"] is True, "an unknown tool is a 200 with is_error")
    check("no_such_tool" in body["content"], "the unknown-tool answer names what was called")
    check(body["tool_call_id"] == "c1", "the answer echoes the call's id")
    check(body["diff"] == "", "the envelope always carries a diff (empty when nothing changed)")

    status, body = exec_call(base, {"name": "run_command", "arguments": '{"command": ', "tool_call_id": "c2"})
    check(status == 200 and body["is_error"] is True, "unparsable arguments are the model's own mistake: a 200 envelope")
    check(body["content"].startswith("ERROR:"), "the parse failure is what the model reads")

    status, body = exec_call(
        base, {"name": "run_command", "arguments": json.dumps({"command": "echo hi"}), "tool_call_id": "c3"}
    )
    check(status == 200 and body["is_error"] is False, "a plain command runs and answers is_error=false")
    check("hi" in body["content"], "the command's own output is what comes back")
    check(body["content"].startswith("OK:"), "a success is said the one way every tool says it")

    # mode reaches the tool's own judgement: chat may not write
    status, body = exec_call(
        base,
        {"name": "run_command", "arguments": json.dumps({"command": "touch chat.txt"}), "tool_call_id": "c4", "mode": "chat"},
    )
    check(status == 200 and body["is_error"] is True, "chat mode refuses a write without asking anybody")
    check(not (project.workdir / "chat.txt").exists(), "the refused write really did not happen")

    status, body = exec_call(
        base,
        {"name": "run_command", "arguments": json.dumps({"command": "touch work.txt"}), "tool_call_id": "c5", "mode": "work"},
    )
    check(status == 200 and body["is_error"] is False, "the same command runs in work mode")
    check((project.workdir / "work.txt").exists(), "work mode really wrote the file")

    check(state.exec_cancels == {} and state.gates == [], "every finished call released its gate and its cancel entry")


# ---- 3. permission, judged here ------------------------------------------------


def permission_check(tmp: Path) -> None:
    base, broadcaster, state, project, _srv = open_server(tmp, "permission")
    root = project.workdir
    q = broadcaster.subscribe(str(project.path))

    # (a) denied by the user: the call does not run
    keep = root / "keep.txt"
    keep.write_text("still here", encoding="utf-8")
    t, box = in_thread(
        lambda: exec_call(base, {"name": "run_command", "arguments": json.dumps({"command": "rm keep.txt"}), "tool_call_id": "p1"})
    )
    ev = next_event(q)
    check(isinstance(ev, PermissionRequestEvent), "an ask is published to the watching window")
    check(ev.tool == "run_command" and "rm keep.txt" in ev.args_repr, "the prompt carries the call and its arguments")
    check(ev.reason, "the prompt says why it is asking")
    status, body = http_post(f"{base}/api/permission/respond", {"request_id": ev.request_id, "allow": False})
    check(status == 200, "the window's deny is accepted")
    t.join(timeout=15)
    check(not t.is_alive(), "the blocked call returns once the prompt is answered")
    check("error" not in box, f"the call answered instead of raising ({box.get('error')})")
    _status, answer = box["value"]  # type: ignore[misc]
    check(answer["is_error"] is True, "a denied call is an error envelope")
    check("denied by user" in answer["content"], "the model hears the user's verdict")
    check(keep.exists() and keep.read_text(encoding="utf-8") == "still here", "a denied command really did not run")

    # (b) allowed by the user: the same call runs
    t, box = in_thread(
        lambda: exec_call(base, {"name": "run_command", "arguments": json.dumps({"command": "rm keep.txt"}), "tool_call_id": "p2"})
    )
    ev = next_event(q)
    status, _body = http_post(f"{base}/api/permission/respond", {"request_id": ev.request_id, "allow": True})
    check(status == 200, "the window's allow is accepted")
    t.join(timeout=15)
    check(not t.is_alive(), "the allowed call returns")
    _status, answer = box["value"]  # type: ignore[misc]
    check(answer["is_error"] is False, "an allowed command answers success")
    check(not keep.exists(), "the allowed command really ran")

    # an answered prompt cannot be answered twice
    status, body = http_post(f"{base}/api/permission/respond", {"request_id": ev.request_id, "allow": True})
    check(
        status == 400 and "no pending" in json.dumps(body),
        "a prompt whose call already answered is gone: there is nothing to resolve any more",
    )

    # (c) nobody watching is NOT permission: the call waits for a window that
    # could answer it (permission.DETACH_GRACE_S, the same rule a live run has —
    # an SSE reconnect must not turn an approvable command into "denied"), and
    # Stop ends the wait as the user's denial.
    broadcaster.unsubscribe(q)
    other = root / "other.txt"
    other.write_text("x", encoding="utf-8")
    t, box = in_thread(
        lambda: exec_call(base, {"name": "run_command", "arguments": json.dumps({"command": "rm other.txt"}), "tool_call_id": "p3"})
    )
    deadline = time.monotonic() + 5.0
    while "p3" not in state.exec_cancels and time.monotonic() < deadline:
        time.sleep(0.02)
    check("p3" in state.exec_cancels, "an unanswered ask keeps the call in flight, not silently allowed")
    time.sleep(0.5)
    check(t.is_alive(), "with no window attached the call waits instead of guessing")
    check(other.exists(), "the unanswered command really did not run")
    status, _body = http_post(f"{base}/api/stop", {})
    check(status == 200, "Stop is accepted while a prompt waits")
    t.join(timeout=15)
    check(not t.is_alive(), "Stop ends the wait instead of leaving the call hanging")
    _status, answer = box["value"]  # type: ignore[misc]
    check(answer["is_error"] is True, "a prompt resolved by Stop is an error envelope")
    check("denied by user" in answer["content"], "Stop's verdict reaches the model in the user's words")
    check(other.exists(), "the command Stop denied did not run")

    # (d) a prompt is a UI event, never a .clc line (P3-4)
    types = [e.type for e in project.log.events()]
    check(
        "permission_request" not in types,
        "the permission prompt never reaches the log: it is one call's question, not a step of the turn",
    )
    check(types.count("tool_result") == 0, "the endpoint writes no events at all: the host appends the result")

    check(state.gate is None and state.gates == [], "no gate outlives the calls that made it")
    check(state.exec_cancels == {}, "no cancel entry outlives the calls that made it")


# ---- 4. Stop reaches the running command ---------------------------------------


def cancel_check(tmp: Path) -> None:
    base, _bc, state, project, _srv = open_server(tmp, "cancel")

    t, box = in_thread(
        lambda: exec_call(base, {"name": "run_command", "arguments": json.dumps({"command": "sleep 5"}), "tool_call_id": "k1"})
    )
    deadline = time.monotonic() + 5.0
    while "k1" not in state.exec_cancels and time.monotonic() < deadline:
        time.sleep(0.02)
    check("k1" in state.exec_cancels, "a running call registers the interrupt an outside Stop addresses")

    # a second live call cannot reuse the id: two calls, one identity
    status, body = exec_call(base, {"name": "run_command", "arguments": json.dumps({"command": "echo x"}), "tool_call_id": "k1"})
    check(status == 409 and "already in flight" in json.dumps(body), "a duplicate live tool_call_id is refused")

    started = time.monotonic()
    status, body = http_post(f"{base}/api/exec/cancel", {"tool_call_id": "k1"})
    check(status == 200 and body_of((status, body))["status"] == "cancelling", "cancel answers what it is doing")
    t.join(timeout=15)
    check(not t.is_alive(), "the cancelled call returns")
    _status, answer = box["value"]  # type: ignore[misc]
    check(answer["is_error"] is True, "a cancelled command is an error envelope")
    check("aborted" in answer["content"], "the model hears that it was stopped, not that it broke")
    check(time.monotonic() - started < 4.5, "the command was killed inside its own lifetime, not waited out")
    check("k1" not in state.exec_cancels, "the cancel entry is released with the call")

    status, body = http_post(f"{base}/api/exec/cancel", {"tool_call_id": "k1"})
    check(status == 404, "cancelling a call that is no longer running says so, instead of pretending")
    status, body = http_post(f"{base}/api/exec/cancel", {})
    check(status == 400, "cancel without a tool_call_id is refused")

    # Stop (POST /api/stop) must also unblock a running exec call
    t, box = in_thread(
        lambda: exec_call(base, {"name": "run_command", "arguments": json.dumps({"command": "sleep 5"}), "tool_call_id": "k2"})
    )
    deadline = time.monotonic() + 5.0
    while "k2" not in state.exec_cancels and time.monotonic() < deadline:
        time.sleep(0.02)
    check("k2" in state.exec_cancels, "the second call is running")
    started = time.monotonic()
    status, _body = http_post(f"{base}/api/stop", {})
    check(status == 200, "Stop is accepted")
    t.join(timeout=15)
    check(not t.is_alive(), "Stop returns the running call instead of leaving it running")
    check(time.monotonic() - started < 4.5, "Stop killed the command tree promptly")
    _status, answer = box["value"]  # type: ignore[misc]
    check(answer["is_error"] is True, "the stopped call is an error envelope")


# ---- 5. a read-only project runs nothing ---------------------------------------


def read_only_check(tmp: Path) -> None:
    base, broadcaster, state, project, _srv = open_server(tmp, "readonly", read_only=True)
    target = project.workdir / "ro.txt"
    status, body = exec_call(
        base, {"name": "run_command", "arguments": json.dumps({"command": "touch ro.txt"}), "tool_call_id": "r1"}
    )
    check(status == 409, "a read-only project refuses a call before it runs")
    check(
        json.dumps(body).find("read_only") >= 0,
        "the refusal carries the code the client matches on (the same one api/log.py uses)",
    )
    check(not target.exists(), "the refused call really did not touch the workspace")
    check(state.gate is None and state.exec_cancels == {}, "the refused call created no gate and no cancel entry")
    check(broadcaster.count(str(project.path)) == 0, "nothing was published for a refused call")


def main() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        shape_check(tmp)
        envelope_check(tmp)
        permission_check(tmp)
        cancel_check(tmp)
        read_only_check(tmp)
    print("exec_api: ok")


if __name__ == "__main__":
    try:
        main()
    except AssertionError:
        sys.exit(1)
