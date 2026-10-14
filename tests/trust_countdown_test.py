"""Trust mode's countdown runs on the FAR side, not on the page.

Run: uv run python -m tests.trust_countdown_test

The failure this guards (the permission twin of the M4 tunnel freeze): trust
mode arms a prompt to answer ITSELF with allow after TRUST_COUNTDOWN_S
("the Allow button presses itself"). That countdown used to live only in the
renderer (ui/js/permissions.js setTimeout chain) — and Android freezes the
WebView and its timers the moment the app goes to the background (see
ui/js/sse-stream.js sseSuspend). So a prompt armed at 10s, then backgrounded,
simply stopped counting: the phone came back to a dialog that had "nearly"
expired while the run sat blocked in PermissionGate.require the whole time —
which has no timeout by design, so the run never finished, the supervisor never
reaped the session, and the project stayed write-locked.

The countdown therefore belongs where the polling happens — PermissionGate's
wait loop — with the page's clock demoted to a LABEL. The flag is mirrored far
side by POST /api/permission/trust (agent/api/events.py _permission_trust) into
RunState.trust_armed, and read LIVE by the gate: arming mid-prompt starts the
clock, disarming cancels it, exactly like clicking the button. A frozen phone is
still ATTACHED (its socket keeps the stream alive), so the wait is not the
detach path — the far-side clock is what ends it.

This file pins the far side; tests/trust-countdown-test.js pins the renderer
(the display clock, the wake hooks, the mirroring POST) and section 7 below
pins the two constants to each other.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from agent.base import Broadcaster
from agent.config import Config
from agent.core.permission import (
    TRUST_COUNTDOWN_S,
    PermissionEvaluator,
    PermissionGate,
    PermissionRequired,
)
from agent.project import ProjectLock, create_project
from agent.server import RunState, build
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check, http_post, ui_source

# an ask-triggering call (like gate_detach_test): "echo hi" is auto-allowed and
# never reaches the gate, so it could not tell trust mode's clock from no clock
ASK_ARGS = '{"command": "rm -rf /tmp/x"}'


def _require_in_thread(
    gate: PermissionGate,
    ws,
    out: dict,
    tool: str = "run_command",
    args: str = ASK_ARGS,
    access: str = "command",
) -> threading.Thread:
    def _run() -> None:
        try:
            gate.require(tool, args, ws, access)
            out["ok"] = True
        except PermissionRequired as e:
            out["err"] = e.reason

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def _wait_pending(gate: PermissionGate, timeout: float = 5.0) -> list[str]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        ids = gate.pending_ids()
        if ids:
            return ids
        time.sleep(0.005)
    return gate.pending_ids()


def _gate(armed: dict, trust_s: float) -> PermissionGate:
    """A gate on a UI that is ATTACHED but frozen — the phone in the background.

    is_attached reads True on purpose: the whole premise is that a frozen page
    is not a gone one (agent/core/permission.py DETACH_GRACE_S), so the only
    thing that can end the wait is the far-side clock under test.
    """
    return PermissionGate(
        evaluator=PermissionEvaluator(),
        on_ask=lambda *a: True,
        is_attached=lambda: True,
        attach_poll_s=0.01,
        trust=lambda: armed["on"],
        trust_s=trust_s,
    )


def _armed_ask_answers_itself(tmp: str) -> None:
    # the frozen-phone case end to end: nobody answers, no page timer runs, and
    # the ask still allows itself once the far-side clock is up.
    ws = LocalWorkspace(tmp)
    armed = {"on": True}
    gate = _gate(armed, trust_s=0.25)
    out: dict = {}
    t0 = time.monotonic()
    t = _require_in_thread(gate, ws, out)
    t.join(timeout=5)
    waited = time.monotonic() - t0
    check(not t.is_alive(), "an armed ask ends with no UI answer at all")
    check(out.get("ok") and "err" not in out, f"the armed ask allowed the call ({out!r})")
    check(waited >= 0.15, f"it waited the countdown instead of allowing at once ({waited:.3f}s)")
    check(gate.pending_ids() == [], "the answered ask left no prompt behind")


def _disarmed_ask_still_waits(tmp: str) -> None:
    # the fix must not turn every prompt into an auto-allow: trust is a mode.
    ws = LocalWorkspace(tmp)
    armed = {"on": False}
    gate = _gate(armed, trust_s=0.2)
    out: dict = {}
    t = _require_in_thread(gate, ws, out)
    ids = _wait_pending(gate)
    check(len(ids) == 1, "a disarmed ask waits like any other prompt")
    time.sleep(0.6)  # an armed gate would have answered it three times over
    check(t.is_alive(), "a disarmed ask is still waiting long after the countdown")
    check(gate.pending_ids() == ids, "the prompt is still on the table")
    check(gate.resolve(ids[0], True), "the user's own Allow still lands on it")
    t.join(timeout=5)
    check(out.get("ok"), f"the user's answer ends the wait ({out!r})")


def _disarming_mid_countdown_cancels(tmp: str) -> None:
    # the flag is re-read every poll, so it behaves like the button: switching
    # trust OFF while a prompt waits must stop the clock it started.
    ws = LocalWorkspace(tmp)
    armed = {"on": True}
    gate = _gate(armed, trust_s=0.8)
    out: dict = {}
    t = _require_in_thread(gate, ws, out)
    ids = _wait_pending(gate)
    time.sleep(0.25)  # inside the countdown
    armed["on"] = False
    time.sleep(1.2)  # past the deadline the armed clock had
    check(t.is_alive(), "disarming mid-countdown cancels the armed clock")
    check(out.get("ok") is None, f"no verdict was invented while disarmed ({out!r})")
    check(gate.pending_ids() == ids, "the prompt is still waiting for the user")
    check(gate.resolve(ids[0], True), "the user answers it afterwards")
    t.join(timeout=5)
    check(out.get("ok"), f"the late answer still lands ({out!r})")


def _arming_mid_prompt_starts_the_clock(tmp: str) -> None:
    # arming while a disarmed prompt waits: the full countdown starts from the
    # ARMING, never a leftover from before it — the same clock the button arms.
    ws = LocalWorkspace(tmp)
    armed = {"on": False}
    gate = _gate(armed, trust_s=0.3)
    out: dict = {}
    t = _require_in_thread(gate, ws, out)
    ids = _wait_pending(gate)
    time.sleep(0.6)  # two clocks' worth of disarmed waiting
    check(t.is_alive(), "a prompt nobody armed is still waiting")
    armed_at = time.monotonic()
    armed["on"] = True
    t.join(timeout=5)
    waited = time.monotonic() - armed_at
    check(out.get("ok"), f"arming mid-prompt lets the ask answer itself ({out!r})")
    check(waited >= 0.2, f"the clock started at the arming, not at the ask ({waited:.3f}s)")
    check(waited < 2.0, f"and it did fire, on the countdown it owns ({waited:.3f}s)")
    check(gate.pending_ids() == [], "the answered ask left no prompt behind")


def _trust_allows_an_escape(tmp: str) -> None:
    # trust is "the Allow button presses itself", and Allow is also the only way
    # an escape is ever permitted — so an armed escape ask must be allowed AND
    # its paths recorded on the workspace for that call (unlike auto_allow /
    # non_interactive, which fail closed on escapes).
    root = Path(tmp) / "ws"
    root.mkdir()
    ws = LocalWorkspace(str(root))
    ext = Path(tmp) / "outside.txt"
    armed = {"on": True}
    gate = _gate(armed, trust_s=0.2)
    out: dict = {}
    t = _require_in_thread(
        gate, ws, out, tool="write_file", args=json.dumps({"path": str(ext)}), access="write"
    )
    t.join(timeout=5)
    check(out.get("ok"), f"trust allows the escape, not only a rule ask ({out!r})")
    check(ws.resolve(str(ext)) == ws.realpath(ext), "the allowed escape is recorded for the call")


def _no_trust_probe_is_the_plain_wait(tmp: str) -> None:
    # a host that never wired the flag keeps the old contract: wait forever.
    ws = LocalWorkspace(tmp)
    gate = PermissionGate(
        evaluator=PermissionEvaluator(),
        on_ask=lambda *a: True,
        is_attached=lambda: True,
        attach_poll_s=0.01,
    )
    check(gate.trust is None, "a gate built without trust has no probe")
    out: dict = {}
    t = _require_in_thread(gate, ws, out)
    ids = _wait_pending(gate)
    time.sleep(0.4)
    check(t.is_alive(), "with no trust probe the prompt never answers itself")
    check(gate.resolve(ids[0], False), "the user can still deny it")
    t.join(timeout=5)
    check(out.get("err") == "denied by user", f"the denial reaches the run ({out!r})")


def _constants_stay_in_step() -> None:
    # the far side owns the countdown; the page's number is the label on the
    # Allow button, so they must name the same seconds (the comment in both
    # files says "keep in step" — this is what enforces it).
    check(TRUST_COUNTDOWN_S == 10.0, f"the gate counts 10s ({TRUST_COUNTDOWN_S})")
    m = re.search(r"const TRUST_COUNTDOWN_S = (\d+(?:\.\d+)?);", ui_source())
    check(m is not None, "the renderer declares its display countdown")
    check(
        m is not None and float(m.group(1)) == TRUST_COUNTDOWN_S,
        f"the page's label counts the same seconds ({m.group(1) if m else '?'} vs {TRUST_COUNTDOWN_S})",
    )


def _post_raw(url: str, raw: bytes) -> tuple[int, str]:
    req = urllib.request.Request(
        url, data=raw, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def _endpoint_arms_the_live_gate() -> None:
    # the seam: the page's POST must flip the very flag the RUNNING run's gate
    # reads, with no new run and no restart — a session replaced under a window
    # starts disarmed, so the page re-sends on every (re)connect.
    broadcaster = Broadcaster()
    state = RunState()
    state.api_key = "sk-fake"  # build_llm only constructs a client; nothing dials out
    cfg = Config(port=0, base_url="http://127.0.0.1:1/v1", model="m")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        project = create_project(tmp / "w.clc", "w", "prov/model")
        srv = build(cfg, broadcaster, state)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{cfg.port}/api/permission/trust"
        watcher = None
        try:
            run = srv.app.start_task("t", project)
            check(run is not None, "a run's gate is assembled from this state")
            check(
                state.trust_armed is False and run.gate.trust() is False,
                "a fresh session starts disarmed",
            )

            status, body = http_post(url, {"armed": True})
            check(status == 200, f"arming is accepted ({status} {body!r})")
            check(json.loads(body) == {"status": "ok", "armed": True}, f"the reply echoes the flag ({body!r})")
            check(state.trust_armed is True, "the endpoint flips RunState.trust_armed")
            check(run.gate.trust() is True, "the LIVE gate sees the arm, with no new run")

            # and that gate, so armed, now answers its own ask — the frozen phone
            # it is standing in for keeps its stream open, so it is attached
            watcher = broadcaster.subscribe(str(project.path))
            run.gate.trust_s = 0.3  # the countdown is 10s; the wiring is what is on trial
            out: dict = {}
            t = _require_in_thread(run.gate, LocalWorkspace(str(tmp)), out)
            t.join(timeout=5)
            check(out.get("ok"), f"the armed live gate allowed the ask itself ({out!r})")
            check(run.gate.pending_ids() == [], "no prompt is left behind on the live gate")

            status, body = http_post(url, {"armed": False})
            check(json.loads(body) == {"status": "ok", "armed": False}, f"disarming is echoed ({body!r})")
            check(state.trust_armed is False and run.gate.trust() is False, "disarm reaches the gate too")

            status, body = http_post(url)  # empty body: {armed: false} is a disarm
            check(status == 200, f"an empty body is accepted ({status} {body!r})")
            check(json.loads(body)["armed"] is False, f"an empty body disarms ({body!r})")

            status, _ = _post_raw(url, b"not json")
            check(status == 400, f"a malformed body is a 400, not a silent arm ({status})")
            check(state.trust_armed is False, "the malformed body changed nothing")
        finally:
            if watcher is not None:
                broadcaster.unsubscribe(watcher)
            srv.shutdown()
            ProjectLock.release(project.lock)
            project.lock = None


def main() -> int:
    with tempfile.TemporaryDirectory() as wtmp:
        _armed_ask_answers_itself(wtmp)
        print("ok - an armed ask answers itself; the page's frozen clock is not needed")
        _disarmed_ask_still_waits(wtmp)
        print("ok - a disarmed ask still waits for the user")
        _disarming_mid_countdown_cancels(wtmp)
        print("ok - disarming mid-countdown cancels the clock")
        _arming_mid_prompt_starts_the_clock(wtmp)
        print("ok - arming mid-prompt starts a full countdown")
        _trust_allows_an_escape(wtmp)
        print("ok - trust allows an escape and records it for the call")
        _no_trust_probe_is_the_plain_wait(wtmp)
        print("ok - a gate with no trust probe waits like before")
    _constants_stay_in_step()
    print("ok - the gate's countdown and the page's label are the same seconds")
    _endpoint_arms_the_live_gate()
    print("ok - POST /api/permission/trust arms the flag the live gate reads")
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
