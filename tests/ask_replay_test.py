"""Permission prompts are recoverable state: none is ever delivered exactly once.

Run: uv run python -m tests.ask_replay_test

The failure this guards (observed live, more than once): a permission ask is
published to the broadcaster ONCE. A window that misses that one frame — a
reload mid-ask, an EventSource between reconnects, or a renderer still
reconstructing history (which drops live prompts on purpose, see
ui/js/stream-events.js) — never learns the prompt exists. No dialog appears, the
run sits blocked in gate.require until the user presses Stop, and Stop answers
every pending ask "denied by user" — a denial nobody ever saw a prompt for.

So an ask is STATE while it waits, not a frame that was sent once:

* PermissionGate.pending_asks() lists every ask still on the table, and
  resolve() removes it the moment the verdict lands (never re-delivered after);
* agent/api/events.py hands those asks to every (re)connecting stream that can
  answer them — the reload/reconnect recovery;
* the gate re-announces the ask while it waits (REANNOUNCE_S) — a prompt that
  was dropped without a reconnect still surfaces, and the UI renders the same
  request_id in place (ui/js/permissions.js) instead of stacking dialogs.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote

from agent.base import Broadcaster
from agent.config import Config
from agent.core.permission import (
    PermissionEvaluator,
    PermissionGate,
    PermissionRequired,
)
from agent.events import PermissionRequestEvent
from agent.project import ProjectLock, create_project
from agent.server import RunState, build
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check

# an ask-triggering call (like gate_detach_test): "echo hi" would be auto-allowed
ASK_ARGS = '{"command": "rm -rf /tmp/x"}'


def _require_in_thread(gate: PermissionGate, ws, out: dict) -> threading.Thread:
    def _run() -> None:
        try:
            gate.require("run_command", ASK_ARGS, ws, "command")
            out["ok"] = True
        except PermissionRequired as e:
            out["err"] = e.reason

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def _wait_for_pending(gate: PermissionGate, timeout: float = 5.0) -> list[tuple[str, str, str, str]]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        asks = gate.pending_asks()
        if asks:
            return asks
        time.sleep(0.01)
    return gate.pending_asks()


class _Stream:
    """One open /api/events stream, its frames collected on a reader thread."""

    def __init__(self, url: str, timeout: float = 15.0) -> None:
        self.frames: list[dict] = []
        self._cond = threading.Condition()
        self._r = urllib.request.urlopen(url, timeout=timeout)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        try:
            for raw in self._r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: "):
                    continue
                try:
                    ev = json.loads(line[6:])
                except ValueError:
                    continue
                with self._cond:
                    self.frames.append(ev)
                    self._cond.notify_all()
        except Exception:  # noqa: BLE001 -- a closed stream just ends the thread
            pass

    def wait_for(self, pred, timeout: float = 10.0, start: int = 0):
        """(index, frame) of the first frame after `start` matching pred, else None."""
        deadline = time.time() + timeout
        with self._cond:
            while True:
                for i in range(start, len(self.frames)):
                    if pred(self.frames[i]):
                        return i, self.frames[i]
                left = deadline - time.time()
                if left <= 0:
                    return None
                self._cond.wait(left)

    def close(self) -> None:
        try:
            self._r.close()
        except Exception:  # noqa: BLE001
            pass


def _pending_ask_is_state(tmp: str) -> None:
    # what a re-delivery is made of: the ask's identity and payload, kept for as
    # long as the ask waits — and dropped the moment the verdict lands
    ws = LocalWorkspace(tmp)
    gate = PermissionGate(
        evaluator=PermissionEvaluator(),
        on_ask=lambda *a: True,
        is_attached=lambda: True,
    )
    out: dict = {}
    t = _require_in_thread(gate, ws, out)
    asks = _wait_for_pending(gate)
    check(len(asks) == 1, f"the blocked run is listed as one waiting ask ({asks})")
    rid, tool, args_repr, reason = asks[0]
    check(rid.startswith("perm-"), f"the ask carries its request id ({rid})")
    check(tool == "run_command" and args_repr == ASK_ARGS, "the ask keeps the call to re-send")
    check("outside the workspace" in reason, f"the ask keeps why it asks ({reason!r})")
    check(gate.pending_ids() == [rid], "pending_ids agrees with pending_asks")

    check(gate.resolve(rid, True), "the verdict finds the ask")
    check(gate.pending_asks() == [], "a resolved ask leaves the table at once: never re-delivered")
    check(not gate.resolve(rid, True), "a second verdict is refused (already resolved)")
    t.join(timeout=5)
    check(not t.is_alive() and out.get("ok"), f"the allow verdict reaches the run ({out})")


def _ask_is_reannounced_while_it_waits(tmp: str) -> None:
    # the same ask, same request_id, until it is answered: a drop without a
    # reconnect must not cost the user the prompt
    ws = LocalWorkspace(tmp)
    calls: list[tuple] = []
    gate = PermissionGate(
        evaluator=PermissionEvaluator(),
        on_ask=lambda *a: calls.append(a) or True,
        is_attached=lambda: True,
        reannounce_s=0.05,
        attach_poll_s=0.01,
    )
    out: dict = {}
    t = _require_in_thread(gate, ws, out)
    asks = _wait_for_pending(gate)
    check(len(asks) == 1, "the ask is waiting")
    time.sleep(0.3)
    gate.resolve(asks[0][0], True)
    t.join(timeout=5)
    check(not t.is_alive() and out.get("ok"), f"the run continues once answered ({out})")
    check(len(calls) >= 3, f"the prompt is re-announced while it waits ({len(calls)} announcements)")
    check(len(set(calls)) == 1, "every announcement is the same ask (same request_id)")
    settled = len(calls)
    time.sleep(0.2)
    check(len(calls) == settled, "no announcement is made after the verdict")


def _publish(broadcaster: Broadcaster, request_id: str, tool: str, args_repr: str, reason: str) -> bool:
    # the run's own on_ask (agent/api/run.py): one publish to the broadcaster
    broadcaster.publish(
        PermissionRequestEvent(request_id=request_id, tool=tool, args_repr=args_repr, reason=reason)
    )
    return True


def _sse_streams_redeliver_pending_asks() -> None:
    broadcaster = Broadcaster()
    state = RunState()
    cfg = Config(port=0, base_url="http://127.0.0.1:1/v1", model="m")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        pa = create_project(tmp / "a.clc", "a", "prov/model")
        pb = create_project(tmp / "b.clc", "b", "prov/model")
        win = after = other = None
        try:
            srv = build(cfg, broadcaster, state)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{cfg.port}"

            gate = PermissionGate(
                evaluator=PermissionEvaluator(),
                on_ask=lambda *a: _publish(broadcaster, *a),
                is_attached=lambda: broadcaster.count(str(pa.path)) > 0,
                detach_grace_s=60.0,  # the test's brief stream gaps are not verdicts
            )
            state.gate = gate
            state.run_project = str(pa.path)

            # the ask is published while NO window is watching — the very case
            # that used to lose it forever
            out: dict = {}
            t = _require_in_thread(gate, LocalWorkspace(str(tmp)), out)
            asks = _wait_for_pending(gate)
            check(len(asks) == 1, "the run is blocked on one ask")
            first = asks[0]

            # another project's window is not this ask's audience
            other = _Stream(f"{base}/api/events?project={quote(str(pb.path))}")
            check(
                other.wait_for(lambda e: e.get("type") == "replayed") is not None,
                "the other project's stream replays its own history",
            )
            check(
                other.wait_for(lambda e: e.get("type") == "permission_request", timeout=0.5) is None,
                "another project's window is not shown this ask",
            )
            other.close()

            # a window that connects AFTER the ask exists is handed it — this is
            # the reload/reconnect recovery the live publish could never give
            win = _Stream(f"{base}/api/events?project={quote(str(pa.path))}")
            got = win.wait_for(lambda e: e.get("type") == "permission_request")
            check(got is not None, "a (re)connecting window is handed the ask it never saw")
            _, ev = got
            check(ev.get("request_id") == first[0], "the re-delivered ask keeps its request id")
            check(
                ev.get("tool") == "run_command" and ev.get("args_repr") == ASK_ARGS,
                "the re-delivered ask keeps the call it asks about",
            )
            check(ev.get("reason") == first[3], "the re-delivered ask keeps its reason")

            # live delivery is unaffected: a NEW ask still arrives on the open stream
            check(gate.resolve(first[0], False), "denying the first ask")
            t.join(timeout=5)
            check(out.get("err") == "denied by user", f"the denial reaches the run ({out})")
            out2: dict = {}
            t2 = _require_in_thread(gate, LocalWorkspace(str(tmp)), out2)
            second = _wait_for_pending(gate)
            check(len(second) == 1 and second[0][0] != first[0], "a second ask waits")
            got2 = win.wait_for(lambda e: e.get("type") == "permission_request", start=got[0] + 1)
            check(got2 is not None, "a live ask still reaches an already-open stream")
            check(got2[1].get("request_id") == second[0][0], "the live ask is the new one")
            check(gate.resolve(second[0][0], True), "allowing the second ask")
            t2.join(timeout=5)
            check(out2.get("ok"), f"the second run continues ({out2})")

            # and once answered, the ask is gone: no stream is ever shown it again
            win.close()
            after = _Stream(f"{base}/api/events?project={quote(str(pa.path))}")
            check(
                after.wait_for(lambda e: e.get("type") == "replayed") is not None,
                "the project's stream replays its history",
            )
            check(
                after.wait_for(lambda e: e.get("type") == "permission_request", timeout=0.5) is None,
                "an answered ask is never re-delivered",
            )
            srv.shutdown()
        finally:
            for s in (win, after, other):
                if s is not None:
                    s.close()
            ProjectLock.release(pa.lock)
            pa.lock = None
            ProjectLock.release(pb.lock)
            pb.lock = None


def main() -> int:
    with tempfile.TemporaryDirectory() as wtmp:
        _pending_ask_is_state(wtmp)
        print("ok - a waiting ask is state: listed, re-sendable, dropped on resolve")
        _ask_is_reannounced_while_it_waits(wtmp)
        print("ok - a waiting ask is re-announced, never after its verdict")
    _sse_streams_redeliver_pending_asks()
    print("ok - SSE streams hand every (re)connect the asks still waiting")
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
