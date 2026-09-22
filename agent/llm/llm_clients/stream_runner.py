"""One streaming attempt + the retry policy that wraps it.

Every provider client (chat completions, responses) streams a turn through the
same contract: a *source* generator that yields internal events (reasoning /
text / tool_call_start / tool_call_delta / finish) and raises on failure. The
retry semantics are subtle enough that they live in exactly one place here; a
client supplies only its request builder and its event translation.

Transport failures raised while the SSE body is being consumed (read timeout /
reset / truncated response) escape the openai SDK unwrapped as raw httpx2
exceptions (see LlmError.classify); the loop below turns them into a retry. A
retry restarts the request from scratch, so it is only safe when NOTHING of this
attempt has reached the caller yet — retrying after a partial stream would
re-emit already-delivered text and duplicate it in the transcript. A failure
after the first event is therefore raised immediately (clear error instead of a
silent stall); a failure before it retries with backoff, yielding a
{"type": "retry", ...} notice first so the caller/UI can show "reconnecting…"
instead of looking frozen until the next attempt dies.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Collection, Iterator

from ..client import LlmError


def run_streaming(
    source: Callable[[], Iterator[dict[str, Any]]],
    *,
    max_retries: int,
    retryable_status: Collection[int],
) -> Iterator[dict[str, Any]]:
    """Drive ``source()`` to completion, retrying pre-delivery failures.

    ``finish`` is the last event a source yields; reaching it ends the turn (this
    generator then stops consuming, whatever the provider still has buffered).
    A source may also raise LlmError itself for a provider-level failure
    (response.failed, a mid-stream error event): it is passed through untouched
    instead of being flattened into the "unknown" catch-all by classify().
    """
    attempts = max(1, int(max_retries))
    for attempt in range(attempts):
        delivered = False
        stream = source()
        try:
            for event in stream:
                if event["type"] == "finish":
                    yield event
                    return  # this attempt completed the turn: never start another
                delivered = True
                yield event
            # a source that ends without a finish event is a bug, not a retryable
            # state (both clients synthesize one before falling off the end)
            raise LlmError(code="unknown", retryable=False, message="stream ended without a finish event")
        except Exception as e:  # noqa: BLE001 -- classify then decide to retry
            last_err = e if isinstance(e, LlmError) else LlmError.classify(e, retryable_status)
            if not last_err.retryable or delivered or attempt == attempts - 1:
                if not delivered and last_err.retryable:
                    # all attempts exhausted: say so instead of a bare transport message
                    last_err.message = f"{last_err.message} (after {attempts} attempts)"
                raise last_err from e
            # announce the retry before the backoff sleep so the caller/UI can
            # show the recovery process instead of a silent stall
            yield {
                "type": "retry",
                "attempt": attempt + 1,
                "max": attempts,
                "code": last_err.code,
                "message": f"{last_err.message} — retrying ({attempt + 1}/{attempts})",
            }
            time.sleep((2**attempt) + attempt * 0.5)
        finally:
            # the attempt is over either way (finish, error, abort): drop the
            # connection now instead of waiting for the generator to be collected
            stream.close()
