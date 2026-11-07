"""The run slot as a LEASE the HOST holds (P2-3): POST /api/run/state.

Run: .venv/bin/python -m tests.run_state_test

The loop that drives a turn lives in the client (TODO.md D1), so the client is
the only one who can say the turn is still alive. Five readers on this side ask
one flag — `/api/health`'s in_flight, the `execution_status` frame a reconnecting
window is handed, the project-switch gates, the rollback gate, and the release
handler's "a run is in flight, write it a final" — and until this endpoint
existed only the retired backend loop wrote it. This suite pins what a host can
rely on:

  1. Claiming says "in flight" to every one of those readers, including the
     status frame a window that just reconnected gets — the P1-5 gap. The claim
     is tagged with the project, so a stream watching ANOTHER `.clc` is still
     told idle (it cannot answer this turn's permission prompts and must not
     paint its transcript running).
  2. It is a LEASE: a claim with a deadline expires by itself. A host that was
     killed is not a session that must be refused forever, and the expiry is
     lazy (readers see it, no timer runs).
  3. Refusals name three different problems — no_project, project_mismatch,
     run_active — and a release from a non-holder is not one of them: Stop can
     arrive twice, and "I was not holding it" answers 200 {released:false}.
  4. There is no second writer: the deadline-less claim the retired backend loop
     used (api/run.py, deleted in P4) is gone with it, so `busy` is read-only
     and every hold on the slot is a lease that can expire.
  5. Bad bodies are refused instead of guessed: `busy` has no default (claim and
     release are opposite answers), and a requested lease is clamped to a range
     a client cannot use to pin the slot open or to lose it by itself.
"""

from __future__ import annotations

import contextlib
import json
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote

from agent.base import Broadcaster, RunState
from agent.config import Config
from agent.project import create_project, open_project_lazy
from agent.server import build
from tests.testsupport import check, http_get, http_post


def open_server(tmp: Path, name: str, with_project: bool = True):
    """A real server (routing + handler wiring), with or without a project open."""
    path = tmp / name / f"{name}.clc"
    if with_project:
        create_project(path, name, model="fake-model")
    cfg = Config(host="127.0.0.1", port=0)
    state = RunState()
    srv = build(cfg, Broadcaster(), state)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{cfg.port}"
    if with_project:
        state.set_project(open_project_lazy(path, workspace=None))
    return base, srv, state, path


def claim(base: str, **body) -> tuple[int, dict]:
    st, out = http_post(base + "/api/run/state", body)
    try:
        return st, json.loads(out)
    except ValueError:
        return st, {"raw": out}


def health(base: str) -> bool:
    st, out = http_get(base + "/api/health")
    check(st == 200, f"GET /api/health is 200 (got {st})")
    return json.loads(out)["in_flight"]


def status_frame(base: str, project: Path) -> str | None:
    """The frame a (re)connecting window is handed FIRST: execution_status.

    This is the reader the P1-5 gap was about: the page takes this frame as a
    RESET, so an idle here paints a live run idle for the rest of the turn.
    """
    url = f"{base}/api/events?project={quote(str(project))}&replay=0"
    deadline = time.time() + 10
    with contextlib.closing(urllib.request.urlopen(url, timeout=10)) as r:
        while time.time() < deadline:
            raw = r.readline()
            if not raw:
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data: "):
                continue
            frame = json.loads(line[6:])
            if frame.get("type") == "state_update" and frame.get("key") == "execution_status":
                return frame.get("value")
    return None


def lifecycle_check(tmp: Path) -> None:
    base, srv, state, path = open_server(tmp, "lease")
    try:
        # ---- nothing in flight, said by every reader
        check(health(base) is False, "a fresh session reports no run in flight")
        check(status_frame(base, path) == "idle", "and the status frame says idle")

        # ---- the claim
        st, got = claim(base, busy=True, project=str(path))
        check(st == 200, f"a claim is 200 (got {st}: {got})")
        check(
            set(got) == {"busy", "project", "lease_ms"},
            f"a claim answers one shape: {sorted(got)}",
        )
        check(got["busy"] is True and got["project"] == str(path), "it names the project it holds")
        check(
            got["lease_ms"] == 120_000,
            f"the default lease is the one the host's 20s heartbeat plans for (got {got['lease_ms']})",
        )
        check(health(base) is True, "the supervisor's reaping now sees a run in flight")
        check(
            status_frame(base, path) == "running",
            "and a window that reconnects mid-turn is told running, not idle (the P1-5 gap)",
        )
        check(state.run_project == str(path), "the slot is tagged with its project")

        # ---- a restore is the same claim, with the caller's own TTL
        st, got = claim(base, busy=True, project=str(path), ttl_ms=30_000)
        check(st == 200 and got["lease_ms"] == 30_000, "renewing answers the lease actually taken")
        check(health(base) is True, "a renewal keeps the run in flight")

        # ---- a stream watching ANOTHER .clc is not told about this turn
        other = tmp / "elsewhere" / "elsewhere.clc"
        create_project(other, "elsewhere", model="fake-model")
        check(
            status_frame(base, other) == "idle",
            "a window watching another project is told idle (it cannot answer this turn's prompts)",
        )
        check(health(base) is True, "and the session's own answer is unchanged")

        # ---- the release
        st, got = claim(base, busy=False)
        check(st == 200, f"a release is 200 (got {st}: {got})")
        check(
            got == {"busy": False, "project": str(path), "released": True},
            f"it answers that it was held: {got}",
        )
        check(health(base) is False, "the run is no longer in flight")
        check(status_frame(base, path) == "idle", "and the next reconnect is told idle")
        check(state.run_project is None, "the project tag is gone with the claim")

        # ---- Stop twice: not an error, and the project is not claimed either
        st, got = claim(base, busy=False)
        check(
            st == 200 and got["released"] is False and got["busy"] is False,
            f"releasing a slot nobody holds answers 200 released:false (got {st}: {got})",
        )
    finally:
        srv.shutdown()
        srv.server_close()


def refusal_check(tmp: Path) -> None:
    # ---- no project: nothing to run in
    empty_base, empty_srv, _empty_state, _p = open_server(tmp, "empty", with_project=False)
    try:
        for body in ({"busy": True}, {"busy": False}):
            st, got = claim(empty_base, **body)
            check(
                st == 409 and got.get("code") == "no_project",
                f"a claim with no project open is 409 no_project (got {st}: {got})",
            )
    finally:
        empty_srv.shutdown()
        empty_srv.server_close()

    base, srv, state, path = open_server(tmp, "refuse")
    try:
        # ---- somebody else's project: a refusal, never a silent switch
        stranger = str(tmp / "stranger" / "stranger.clc")
        st, got = claim(base, busy=True, project=stranger)
        check(
            st == 409 and got.get("code") == "project_mismatch",
            f"claiming another .clc is 409 project_mismatch (got {st}: {got})",
        )
        check(health(base) is False, "a refused claim claimed nothing")
        check(state.project is not None and str(state.project.path) == str(path),
              "and it did not switch this session's project")

        # ---- the holder's own claim is a renewal, not a refusal: a window that
        # repeats its claim keeps the same slot (the retired /api/run latch used
        # to refuse here; the lease took over claiming AND renewing)
        check(state.claim_run(str(path), 30.0) == "", "this session's own host takes the slot")
        st, got = claim(base, busy=True, project=str(path))
        check(st == 200 and got["busy"] is True, f"a repeated claim renews it (got {st}: {got})")
        check(health(base) is True, "and the run is reported in flight")
        st, got = claim(base, busy=False)
        check(
            st == 200 and got.get("released") is True,
            f"the host that holds it gives it back (got {st}: {got})",
        )
        check(health(base) is False, "which the next reader sees as idle")

        st, got = http_post(base + "/api/run", {"project": str(path)})
        check(st == 404, "the retired POST /api/run is gone: the lease is the only claim")

        # ---- bad bodies are refused, not guessed
        for body, why in (
            ({}, "a body with no `busy` (claim and release are opposite answers)"),
            ({"busy": "yes"}, "a non-boolean `busy`"),
            ({"busy": 1}, "an integer `busy`"),
            ({"busy": True, "ttl_ms": 0}, "a zero lease"),
            ({"busy": True, "ttl_ms": -5}, "a negative lease"),
            ({"busy": True, "ttl_ms": "60"}, "a string lease"),
            ({"busy": True, "ttl_ms": True}, "a boolean lease"),
            ({"busy": True, "project": 42}, "a non-string project"),
        ):
            st, got = claim(base, **body)
            check(
                st == 400 and got.get("code") == "bad_request",
                f"{why} is 400 bad_request (got {st}: {got})",
            )
        check(health(base) is False, "none of the refused bodies claimed the slot")

        # ---- a lease is clamped: neither pinnable forever nor self-expiring
        st, got = claim(base, busy=True, ttl_ms=10_000_000)
        check(st == 200 and got["lease_ms"] == 600_000, f"a huge lease is clamped: {got}")
        st, got = claim(base, busy=True, ttl_ms=1)
        check(st == 200 and got["lease_ms"] == 100, f"a 1ms lease is clamped up: {got}")
    finally:
        srv.shutdown()
        srv.server_close()


def expiry_check(tmp: Path) -> None:
    """A lease answers by itself: a host killed mid-turn must not lock the session."""
    base, srv, state, path = open_server(tmp, "expiry")
    try:
        st, got = claim(base, busy=True, ttl_ms=200)
        check(st == 200, f"a short lease is accepted (got {st}: {got})")
        check(health(base) is True, "it is in flight while it lasts")
        check(status_frame(base, path) == "running", "and the reconnect frame agrees")

        time.sleep(0.35)
        check(health(base) is False, "after the deadline the run is no longer in flight — with no timer")
        check(status_frame(base, path) == "idle", "and the reconnect frame says idle")
        check(state.run_project == str(path), "the dead claim's tag is harmless until somebody claims again")

        # a fresh claim from the SAME project takes the slot back
        st, got = claim(base, busy=True)
        check(st == 200 and got["busy"] is True, f"the same project reclaims after expiry (got {st}: {got})")
        st, got = claim(base, busy=False)
        check(st == 200 and got["released"] is True, "and can give it back normally")

        # an expired lease is not a lock: the open project may change, and the
        # OTHER project then claims the slot (a host that died must not pin it)
        second = tmp / "expiry2" / "expiry2.clc"
        create_project(second, "expiry2", model="fake-model")
        state.set_project(open_project_lazy(second, workspace=None))
        st, got = claim(base, busy=True, project=str(second))
        check(
            st == 200 and got["project"] == str(second),
            f"another project can claim once no lease holds the slot (got {st}: {got})",
        )
        check(state.run_project == str(second), "and the slot is tagged with the new project")

        # the OLD project cannot release the new holder's claim
        st, got = claim(base, busy=False, project=str(second))
        check(got["released"] is True, "the holder's own release still works")
    finally:
        srv.shutdown()
        srv.server_close()


def slot_check(tmp: Path) -> None:
    """The slot is the lease and nothing else: no hold without a deadline."""
    path = tmp / "slot" / "slot.clc"
    create_project(path, "slot", model="fake-model")
    state = RunState()
    project = open_project_lazy(path, workspace=None)
    state.set_project(project)
    check(state.busy is False, "a fresh RunState is not busy")
    try:
        state.busy = True  # what the deleted api/run.py used to do
    except AttributeError:
        pass
    else:  # pragma: no cover - the deleted setter coming back is the failure
        check(False, "busy is read-only: there is no deadline-less claim left to make")
    check(state.busy is False, "and a refused write left the slot free")

    # direct answers: the endpoint's refusals are the state's, not invented there
    check(state.claim_run(str(path), 1.0) == "", "claim_run() takes a free slot")
    check(state.busy is True and state.run_lease_until > 0.0, "and stamps a deadline")
    check(state.claim_run(str(path), 1.0) == "", "the holder renews its own lease")
    other = tmp / "slot2" / "slot2.clc"
    create_project(other, "slot2", model="fake-model")
    empty = RunState()
    check(empty.claim_run(str(other), 1.0) == "no_project", "no project open is its own answer")
    check(state.release_run(str(other)) is False, "another project cannot release this slot")
    check(state.busy is True, "which is still held")
    check(state.release_run(str(path)) is True, "the holder gives it back")
    check(state.busy is False and state.run_project is None, "and the slot is empty")

    # run_active: the slot is still tagged with the .clc the session has since
    # switched away from (`set_project` does not release a live lease, because a
    # switch while a turn is driven is exactly what must not happen). A claim
    # from the newly open project would put two drivers on one session.
    check(state.claim_run(str(path), 30.0) == "", "the first project takes the slot")
    state.set_project(open_project_lazy(other, workspace=None))
    check(
        state.claim_run(str(other), 30.0) == "run_active",
        "the slot still held for the previous .clc refuses the newly open project",
    )
    check(state.release_run(str(path)) is True, "the old holder gives it back")
    check(state.claim_run(str(other), 30.0) == "", "and then the new project claims it")
    check(state.release_run(str(other)) is True, "then releases it")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="clutch-runstate-") as td:
        tmp = Path(td)
        print("the lease: claim -> in flight -> release (and the frame a reconnect gets)")
        lifecycle_check(tmp)
        print("refusals: no_project, project_mismatch, run_active, bad bodies, clamped TTLs")
        refusal_check(tmp)
        print("expiry: a dead host's lease answers by itself")
        expiry_check(tmp)
        print("the slot: a lease only, and no deadline-less writer left (P4)")
        slot_check(tmp)
    print()
    print("run state API: all passed")


if __name__ == "__main__":
    main()
