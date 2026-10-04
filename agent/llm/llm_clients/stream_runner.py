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

- an armed guard thread per attempt polls the event and, on Stop, calls the
  attempt's ``close`` from OUTSIDE — that is the only way to break a read
  that is already blocked (closing the connection makes it raise now);
- the backoff between attempts waits on the event instead of ``time.sleep``;
- each attempt's top refuses to start when Stop is already pending.

A Stop-induced failure raises LlmError(code="cancelled", retryable=False) —
never retried, and the loop maps it to the same graceful partial-return a
between-chunk break produces.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Collection, Iterator

from ..client import LlmError

GUARD_POLL_S = 0.25  # how often the guard checks Stop while an attempt is parked in a read

# The redial ladder's cap: a retry waits 1,2,4,...,64,128s and holds at 128s
# after that. Doubling is what makes a budget this long cheap (a handful of
# tries), and holding is what keeps a long outage from turning into a
# once-an-hour probe.
MAX_REDIAL_BACKOFF_S = 128.0


@dataclass
class Attempt:
    """One in-flight request: its event iterator and the way to kill it.

    ``close`` must be safe to call from another thread (the guard runs there)
    and after the stream already ended — it is the watchdog's only lever."""
    events: Iterator[dict[str, Any]]
    close: Callable[[], None]


def _cancel_guard(cancel: threading.Event, close: Callable[[], None]) -> threading.Event:
    """Arm the watchdog for one attempt: on Stop, close the connection from this
    helper thread so a read blocked in the socket raises immediately instead of
    at the read budget. Returns the stop handle; the guard is a daemon, so an
    abandoned process never waits on it."""
    stop = threading.Event()

    def guard() -> None:
        while not stop.wait(GUARD_POLL_S):
            if cancel.is_set():
                try:
                    close()  # may race the stream's own end: best-effort by design
                except Exception:  # noqa: BLE001 -- any outcome still unblocks the read
                    pass
                return

    threading.Thread(target=guard, name="llm-cancel-guard", daemon=True).start()
    return stop


def _cancelled(note: str) -> LlmError:
    return LlmError(code="cancelled", retryable=False, message=note)


def run_streaming(
    source: Callable[[], Attempt],
    *,
    max_retries: int,
    retryable_status: Collection[int],
    cancel: threading.Event | None = None,
    mid_stream_retry: bool = False,
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
    """
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
            guard = _cancel_guard(cancel, turn.close) if cancel is not None else None
            for event in turn.events:
                if event["type"] == "finish":
                    yield event
                    return  # this attempt completed the turn: never start another
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
