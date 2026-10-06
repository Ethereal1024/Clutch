"""One streaming attempt + the retry policy that wraps it.

Every provider client (chat completions, responses) streams a turn through the
same contract: an *attempt factory* that issues the request eagerly and returns
an Attempt — the event iterator plus a ``close`` that kills the underlying
connection — and raises on failure. The retry semantics are subtle enough that
they live in exactly one place here; a client supplies only its request builder
and its event translation.

Transport failures raised while the SSE body is being consumed (read timeout /
reset / truncated response) escape the openai SDK unwrapped as raw httpx2
exceptions (see LlmError.classify); a failure raised by the attempt factory
itself (connection refused / DNS failure / connect timeout while issuing the
request) arrives as a wrapped SDK error. Both are the same class of transport
failure to this loop, and the loop below turns them into a retry. A
retry restarts the request from scratch, so it re-emits whatever this attempt
already streamed — which is exactly what a caller that accumulates deltas has
to undo before the next attempt's events arrive. That undo is what the retry
notice's ``discard`` flag asks for: true means "drop everything you took from the
attempt that just died". A caller that can do that (the agent loop rebuilds the
turn from its own accumulators, the compactor rebuilds the summary) opts in with
``mid_stream_retry=True``, and then a drop in the middle of an answer costs a
reconnect instead of the whole run. A caller that cannot, or does not opt in,
keeps the old behavior: a failure after the first delivered event is raised
immediately (a clear error instead of a silent stall), while a failure before it
retries with backoff, yielding a {"type": "retry", ...} notice first so the
caller/UI can show "reconnecting…" instead of looking frozen until the next
attempt dies.

Cancellation: ``cancel`` (the run's Stop event) is woven through every waiting
point, because the events themselves only surface between chunks — a Stop that
arrives while the thread is parked inside a blocking socket read would otherwise
be unobservable until the read budget (240s) runs out. Three mechanisms:

- an armed watchdog thread per attempt polls the event and, on Stop, calls the
  attempt's ``close`` from OUTSIDE — that is the only way to break a read
  that is already blocked (closing the connection makes it raise now). The same
  thread also exists to break a read nobody else can: when the attempt stays
  silent and a probe down its own path says the endpoint is gone (see
  ``STALL_PROBE_S``), because a client that reconnects cannot reach a read that
  is already parked — see ``probe`` below;
- the backoff between attempts waits on the event instead of ``time.sleep``;
- each attempt's top refuses to start when Stop is already pending.

A Stop-induced failure raises LlmError(code="cancelled", retryable=False) —
never retried, and the loop maps it to the same graceful partial-return a
between-chunk break produces.
"""

from __future__ import annotations

import threading
import time
# monotonic comes in directly: the backoff sleep is the one clock tests replace
# (runner_mod.time), and the watchdog's silence clock must stay real.
from time import monotonic
from dataclasses import dataclass
from typing import Any, Callable, Collection, Iterator

from ..client import LlmError

GUARD_POLL_S = 0.25  # how often the guard checks Stop while an attempt is parked in a read

# The redial ladder's cap: a retry waits 1,2,4,...,64,128s and holds at 128s
# after that. Doubling is what makes a budget this long cheap (a handful of
# tries), and holding is what keeps a long outage from turning into a
# once-an-hour probe.
MAX_REDIAL_BACKOFF_S = 128.0

# How long an attempt may deliver NOTHING before the endpoint's own path is
# probed (see _attempt_watchdog). The read budget below (llm_read_timeout, 240s)
# is a budget for CHUNK GAPS — a provider thinking between chunks is silent for
# tens of seconds, and cutting that off would kill healthy streams. But silence
# has two causes, and they are told apart by the path, not by the clock: a peer
# that went away without a FIN (the client's own proxy behind an SSH hop that
# died is exactly that — the far sshd keeps the local socket readable while its
# channel is gone) parks this thread in a read that will not return on its own
# for the whole budget, no matter how many times the window reconnects. So while
# an attempt is silent this long, ask the endpoint (a trivial request down the
# SAME path) whether it is still there; when it is not, kill the attempt and let
# the ladder redial — which is what recovers the run in seconds instead of
# minutes. Only a path that is PROVABLY gone ever closes an attempt, so a slow
# provider is never punished for thinking.
STALL_PROBE_S = 20.0

# How often the loop re-asks a path it knows is gone (see the pre-flight in
# run_streaming). Short enough that a reconnect — the thing that actually ends
# the outage — is noticed in seconds, long enough that a long one is a trickle
# of tiny GETs rather than a hammering loop.
PATH_POLL_S = 10.0

# How long that pre-flight is willing to hold a redial back before issuing the
# request anyway. Waiting on a witness is only right while the witness is right:
# a probe that never answers (a GET that no endpoint on a bad link can complete,
# while a request with a 240s budget still could) must not be able to replace
# retrying with waiting. Past this, try anyway — and see ``probed_dead`` below
# for what a working attempt then says about the probe.
PATH_WAIT_MAX_S = 180.0


def _path_ok(probe: Callable[[], bool]) -> bool:
    """One probe verdict, with a probe that blows up read as "gone" (it is not an
    answer, so it cannot be taken as one)."""
    try:
        return bool(probe())
    except Exception:  # noqa: BLE001 -- see docstring
        return False


@dataclass
class _Watch:
    """What one attempt's watchdog needs to see, written by the loop below while
    it consumes the stream: when an event last arrived, whether anything was
    delivered at all (a partly delivered attempt is only re-runnable when the
    caller honors ``discard``), and whether the watchdog has already acted.

    ``probe`` is read on every tick rather than captured, because it can be
    retired mid-attempt: a probe contradicted by the very stream it said was gone
    must stop being consulted at once, including by a watchdog already armed with
    it (leaving it in place would let a witness that has just been proven wrong
    cut a healthy stream on its next silence)."""

    last: float  # monotonic time the last event arrived (or the attempt started)
    probe: Callable[[], bool] | None = None  # None = no witness: only Stop closes
    delivered: bool = False
    nudged: bool = False


@dataclass
class Attempt:
    """One in-flight request: its event iterator and the way to kill it.

    ``close`` must be safe to call from another thread (the guard runs there)
    and after the stream already ended — it is the watchdog's only lever."""
    events: Iterator[dict[str, Any]]
    close: Callable[[], None]


def _attempt_watchdog(
    cancel: threading.Event | None,
    close: Callable[[], None],
    watch: _Watch,
    *,
    mid_stream_retry: bool,
    stall_s: float,
) -> threading.Event:
    """Arm one attempt's watchdog: a daemon thread whose only lever is ``close``.

    It is the only way to break a read that is already blocked (closing the
    connection makes it raise now), and it uses that lever for two reasons:

    * ``cancel`` is set (the run's Stop). Unconditional, as before.
    * the attempt has delivered nothing for ``stall_s`` AND ``watch.probe()``
      says the endpoint's path is gone. This is the difference between a provider
      that is thinking and a pipe that is dead: a reconnect by the client cannot
      reach a read that is already parked, so without this the run waits out the
      entire read budget (240s) per attempt while the network is back and nothing
      is wrong on the far side. The probe is only consulted on silence, and the
      attempt is only closed when the probe fails while the attempt stayed
      silent through it — events arriving during the probe are themselves proof
      the path is up, whatever the probe made of it.

    A nudged attempt that had already delivered is only worth re-running when
    the caller honors ``discard``; otherwise the run is left alone, because a
    retry there would duplicate the text the caller keeps.

    Returns the stop handle; the guard is a daemon, so an abandoned process
    never waits on it."""
    stop = threading.Event()

    def guard() -> None:
        while not stop.wait(GUARD_POLL_S):
            if cancel is not None and cancel.is_set():
                _quiet_close(close)
                return
            probe = watch.probe  # re-read: it can be retired under us
            if probe is None or watch.nudged:
                continue
            if monotonic() - watch.last < stall_s:
                continue
            if watch.delivered and not mid_stream_retry:
                continue  # a retry would duplicate what this caller already keeps
            before = watch.last
            alive = _path_ok(probe)
            if watch.nudged or watch.last != before:
                continue  # it answered while we were asking: the path is up
            if alive:
                continue
            watch.nudged = True  # read by the retry decision below
            _quiet_close(close)
            return

    threading.Thread(target=guard, name="llm-attempt-watchdog", daemon=True).start()
    return stop


def _quiet_close(close: Callable[[], None]) -> None:
    """Close an attempt from the watchdog: may race the stream's own end, and
    any outcome still unblocks the read."""
    try:
        close()
    except Exception:  # noqa: BLE001
        pass


def _cancelled(note: str) -> LlmError:
    return LlmError(code="cancelled", retryable=False, message=note)


def _path_gone() -> LlmError:
    """The watchdog's verdict as an error: a probe down the attempt's own path
    found nothing serving it while the attempt stayed silent, so the attempt is
    dead — retryable, because the path coming back is exactly what a redial waits
    for. Used where the close the watchdog performs needs a name: for the read it
    broke, and for a stream that ends "cleanly" because of it."""
    return LlmError(
        code="connection",
        retryable=True,
        message="endpoint stopped answering — the connection path went away",
    )


def run_streaming(
    source: Callable[[], Attempt],
    *,
    max_retries: int,
    retryable_status: Collection[int],
    cancel: threading.Event | None = None,
    mid_stream_retry: bool = False,
    probe: Callable[[], bool] | None = None,
    stall_s: float | None = None,
) -> Iterator[dict[str, Any]]:
    """Drive ``source()`` to completion, retrying transport failures.

    ``finish`` is the last event a source yields; reaching it ends the turn (this
    generator then stops consuming, whatever the provider still has buffered).
    A source may also raise LlmError itself for a provider-level failure
    (response.failed, a mid-stream error event): it is passed through untouched
    instead of being flattened into the "unknown" catch-all by classify().

    ``mid_stream_retry`` is the promise that the CALLER honors ``discard``: with
    it on, an attempt that fails after delivering events is retried too, and the
    notice it yields carries ``discard: true`` so the caller throws away the dead
    attempt's output before the next attempt's events arrive. Off by default —
    re-running a request whose text already reached a caller that does not
    discard would duplicate that text.

    ``probe`` is the endpoint's own liveness check (see _attempt_watchdog): a
    callable answering "is anything still serving this base_url?", consulted
    while an attempt has been silent for ``stall_s`` (default STALL_PROBE_S) and,
    on an unbounded loop, before a retry is issued at all — because a request
    whose answer has to come down a dead hop parks in its own read budget while
    the reconnect that fixed the hop goes unnoticed. A client that can answer it
    hands its own path in here; one that cannot passes None and keeps the old
    behavior (a parked read ends at the read budget, a redial is paced only by
    the ladder).
    """
    stall_s = STALL_PROBE_S if stall_s is None else float(stall_s)
    # A budget counted in ATTEMPTS is a budget in seconds — three attempts used to
    # span ~3.5s — while this call's counterparty is the CLIENT's own proxy across
    # the tunnel: exactly the piece that goes away when the phone is backgrounded
    # or the radio drops. Giving up after seconds is what made a reconnect that
    # DID succeed recover nothing (the run it belonged to was already dead), so
    # ``max_retries <= 0`` means redial until the run's own Stop — which is woven
    # through every wait below — and the ladder holds at MAX_REDIAL_BACKOFF_S.
    unbounded = int(max_retries) <= 0
    attempts = max(1, int(max_retries))
    budget = 0 if unbounded else attempts  # 0 = no fixed budget; the notice shows "…"
    attempt_no = 0
    while unbounded or attempt_no < attempts:
        delivered = False
        if cancel is not None and cancel.is_set():
            raise _cancelled("stop requested before the attempt started")
        turn: Attempt | None = None
        guard: threading.Event | None = None
        watch = _Watch(last=monotonic(), probe=probe)
        probed_dead = False  # this attempt was issued against a "gone" verdict
        if unbounded and probe is not None and attempt_no > 0:
            # Never re-issue a request down a path we can already see is gone.
            # A request's budget for its response HEADERS is the READ budget
            # (240s), so a redial into a dead hop hands the run back to exactly
            # the stall this watchdog exists to break — and that is the half of
            # the report a reconnect alone could not fix: the client's tunnel is
            # back within seconds, but the agent was already parked in a request
            # nobody could answer. Poll the path here instead — cheap and
            # cancel-aware — and leave the moment it answers, so a reconnect
            # costs the run seconds rather than minutes.
            waited = 0.0
            while not _path_ok(probe):
                if waited >= PATH_WAIT_MAX_S:
                    # A witness is only worth waiting on while it is right, and a
                    # probe that never answers must not be able to replace
                    # retrying with waiting: try anyway, and let the attempt
                    # itself say whether the verdict was wrong (below).
                    probed_dead = True
                    break
                if cancel is not None:
                    if cancel.wait(PATH_POLL_S):
                        raise _cancelled("stop requested while waiting for the endpoint to come back")
                else:
                    time.sleep(PATH_POLL_S)
                waited += PATH_POLL_S
        try:
            # the factory issues the request eagerly, so "cannot reach the
            # endpoint at all" (connection refused, DNS failure, connect or read
            # timeout before the response headers) surfaces HERE, not inside the
            # body iteration below. It is the same class of transport failure as
            # a mid-body drop and must be classified, announced and retried the
            # same way — otherwise the very first network hiccup escapes as a
            # raw SDK exception: no retry, no notice, the run dies with the UI
            # still showing "running".
            turn = source()
            if cancel is not None or watch.probe is not None:
                guard = _attempt_watchdog(
                    cancel,
                    turn.close,
                    watch,
                    mid_stream_retry=mid_stream_retry,
                    stall_s=stall_s,
                )
            for event in turn.events:
                if probed_dead and not watch.delivered:
                    # The probe called this path gone and the path is delivering
                    # the request anyway: the witness has been contradicted. Drop
                    # it for the rest of the run — the watchdog re-reads
                    # watch.probe, so it stops consulting it at once rather than
                    # cutting the next silence of a stream we now know is healthy.
                    probe = None
                    watch.probe = None
                # every event is proof of life for the watchdog: it resets the
                # silence clock (and, below, records that this attempt delivered
                # something the caller would have to discard before a retry)
                watch.last = monotonic()
                if event["type"] == "finish":
                    if watch.nudged:
                        # The watchdog closed this attempt (the path is gone) and
                        # the stream ends "cleanly" anyway: that is the close, not
                        # an answer — a client that synthesizes its finish falls
                        # off the end exactly here, and taking this event would
                        # record half an answer as a completed turn. Treat it like
                        # any other dead attempt and redial it instead.
                        raise _path_gone()
                    yield event
                    return  # this attempt completed the turn: never start another
                watch.delivered = True
                delivered = True
                yield event
            # a source that ends without a finish event is a bug, not a retryable
            # state (both clients synthesize one before falling off the end)
            raise LlmError(code="unknown", retryable=False, message="stream ended without a finish event")
        except Exception as e:  # noqa: BLE001 -- classify then decide to retry
            # a Stop that landed mid-read (the guard closed the connection under
            # us) must read as cancellation, never as a retryable transport error
            if cancel is not None and cancel.is_set():
                raise _cancelled("stop requested mid-stream") from e
            last_err = e if isinstance(e, LlmError) else LlmError.classify(e, retryable_status)
            if watch.nudged and not isinstance(e, LlmError):
                # The watchdog closed this attempt because a probe down the SAME
                # path could not reach the endpoint while the stream stayed
                # silent, and the truth is already known: the path is gone. What
                # the close then made the read raise (a reset, a read error, a
                # bare EOF) is noise on the way to saying so, and classifying it
                # would at best bury the reason and at worst make it fatal. A
                # verdict the SOURCE itself produced (an LlmError: a provider's
                # response.failed, a mid-stream error event) is left untouched.
                last_err = _path_gone()

            # a partly delivered attempt is only re-runnable when the caller
            # promised to discard what it already took (mid_stream_retry);
            # otherwise the text that reached it would sit in the transcript twice
            rerunnable = not delivered or mid_stream_retry
            exhausted = not unbounded and attempt_no == attempts - 1
            if not last_err.retryable or not rerunnable or exhausted:
                if last_err.retryable and exhausted:
                    # all attempts exhausted: say so instead of a bare transport message
                    last_err.message = f"{last_err.message} (after {attempts} attempts)"
                raise last_err from e
            # announce the retry before the backoff sleep so the caller/UI can
            # show the recovery process instead of a silent stall. discard=true
            # tells the caller that this attempt already streamed part of its
            # answer and that the caller has to drop it before the next one runs.
            yield {
                "type": "retry",
                "attempt": attempt_no + 1,
                "max": budget,
                "code": last_err.code,
                "discard": delivered,
                "message": f"{last_err.message} — retrying ({attempt_no + 1}/{budget or '…'})",
            }
            # the ladder: 1,2,4,...,MAX_REDIAL_BACKOFF_S and hold there
            delay = min(MAX_REDIAL_BACKOFF_S, 2.0**attempt_no)
            if cancel is not None:
                if cancel.wait(delay):
                    # the stop is its own event, not a consequence of the error
                    # that sent us into this backoff: keep it out of the chain
                    raise _cancelled("stop requested during retry backoff") from None
            else:
                time.sleep(delay)
        finally:
            # the attempt is over either way (finish, error, abort): drop the
            # connection now instead of waiting for the generator to be collected.
            # A factory that failed before handing us a turn has nothing to drop.
            if guard is not None:
                guard.set()  # first: no racing close against our own cleanup
            if turn is not None:
                turn.close()
                events_close = getattr(turn.events, "close", None)
                if events_close is not None:
                    events_close()
        attempt_no += 1
