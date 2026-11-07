"""POST /api/run/state — the HOST's lease on the run slot (P2-3).

The loop that drives a turn lives in the client now (TODO.md D1): the model
call, the context, the tools and the final are all produced by ui/run.js. What
the client cannot do is tell THIS process's other readers that a turn is in
flight — and five of them ask one flag: `/api/health`'s `in_flight` (what the
supervisor's reaping and the ready-check read), the `execution_status` frame a
reconnecting window is handed (api/events), the project-switch gates
(api/project), the rollback gate (api/workspace), and the release handler's
"a run is in flight, write it a final" (server.py). Until this endpoint existed
only the retired backend loop wrote that flag (api/run.py), so a window
reconnecting mid-run was told "idle" and a session could be reaped under a live
turn.

So the host says it here. The request is `{busy, project?, ttl_ms?}`:

  busy:true   claim the slot for this project, or renew the claim already held
  busy:false  give it back (Stop, a turn that ended, a step that failed)

`project` is the same word `/api/run` takes and the same thing it means: a CLAIM
to be checked, not a destination — with two windows on two `.clc` files sharing
one session, a turn quietly recorded into the other window's log is a transcript
nobody asked for. A mismatch is refused, never honored.

It is a LEASE, not a latch, and that is the whole shape of this endpoint. A host
dies without warning — `kill -9`, a phone reclaimed under memory pressure, a
tunnel cut mid-turn — and a latch nobody can release would refuse every project
switch and keep the supervisor from ever reaping that session. A lease answers
by itself. The two ways it can be wrong are not symmetric: a wrong "busy" costs
one delayed project switch and one late reap (seconds to a couple of minutes); a
wrong "idle" paints a live run as idle in a window that just reconnected, and can
have the session reaped under the turn that is using its `.clc`. So the deadline
is generous (api/base.py RunState.LEASE_DEFAULT_S) and the host renews it often.

Refusals are 409s with a `code`, each naming a different problem:

  no_project        nothing is open to run in
  project_mismatch  this session has a different `.clc` open
  run_active        the slot is another driver's (another window's host, or the
                    retired loop's claim, which has no deadline and is therefore
                    never re-signed into one that expires) — two drivers on one
                    turn would write it twice

A release from a non-holder is NOT an error: Stop can arrive twice, or after the
lease already expired on its own, and it answers 200 `{released:false}`. "I was
not holding it" is a fact, not a failure.
"""

from __future__ import annotations

# Bounds on a requested lease. The default is the host's own heartbeat product
# (api/base.py RunState.LEASE_DEFAULT_S); the floor exists so a client cannot
# pin the slot open forever, and the ceiling so a buggy one cannot leave it
# expiring under its own feet after a single missed heartbeat.
LEASE_MS_DEFAULT = 120_000
LEASE_MS_MIN = 100
LEASE_MS_MAX = 600_000

# What each refusal means, in the words the caller reads.
_REFUSAL = {
    "no_project": "no project is open",
    "run_active": "a run is already active",
}


class RunStateMixin:
    "The run slot as a lease the host holds, renews and gives back."

    def _run_state(self) -> None:
        body = self._read_body()
        if body is None:
            return self._json({"error": "bad json body"}, status=400)
        busy = body.get("busy")
        if not isinstance(busy, bool):
            # no default: "claim" and "release" are opposite answers, and
            # guessing which one a body without the field meant is how a Stop
            # turns into a run
            return self._json(
                {"error": "busy must be a boolean", "code": "bad_request"}, status=400
            )
        state = self._state
        project = state.project
        if project is None:
            return self._json({"error": "no project is open", "code": "no_project"}, status=409)
        path = str(project.path)
        claim = body.get("project")
        if claim is not None and not isinstance(claim, str):
            return self._json(
                {"error": "project must be a string", "code": "bad_request"}, status=400
            )
        if claim and claim != path:
            return self._json(
                {
                    "error": f"this session has {path} open, not {claim}",
                    "code": "project_mismatch",
                },
                status=409,
            )
        if not busy:
            released = state.release_run(path)
            return self._json({"busy": state.busy, "project": path, "released": released})
        ttl_ms = body.get("ttl_ms", LEASE_MS_DEFAULT)
        if isinstance(ttl_ms, bool) or not isinstance(ttl_ms, int) or ttl_ms <= 0:
            return self._json(
                {"error": "ttl_ms must be a positive integer", "code": "bad_request"}, status=400
            )
        ttl_ms = max(LEASE_MS_MIN, min(LEASE_MS_MAX, ttl_ms))
        refusal = state.claim_run(path, ttl_ms / 1000.0)
        if refusal:
            why = _REFUSAL.get(refusal) or f"this session has another project open, not {path}"
            return self._json({"error": why, "code": refusal}, status=409)
        # answered with the lease ACTUALLY taken, not the number asked for: a
        # caller whose request was clamped has to know how often to renew
        self._json({"busy": True, "project": path, "lease_ms": ttl_ms})
