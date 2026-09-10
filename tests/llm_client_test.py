"""OpenaiLlmClient stream-resilience checks (no network).

Run: uv run python -m tests.llm_client_test

Covers the mid-stream transport-error fix: httpx2 read-timeout / connection
errors raised while the SSE *body* is being consumed escape the openai SDK
unwrapped (its Stream.__stream__ only closes the response), so the client must
  (a) classify them as retryable (LlmError.classify),
  (b) restart the request — with a visible {"type": "retry"} notice — when
      nothing of the attempt reached the caller yet,
  (c) raise immediately instead of re-streaming duplicated content when the
      stream broke AFTER tokens had already been delivered, and
  (d) report exhaustion with a clear "after N attempts" message.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace

import httpx2

# the client sleeps through backoff via `time.sleep`; swap in a no-op stub so
# the checks never actually wait (scoped to this module, not the global time)
import agent.llm.llm_clients.openai_client as oc_mod
from agent.llm.client import LlmError
from agent.llm.llm_clients.openai_client import OpenaiLlmClient
from tests.testsupport import check

# ---- fake openai SDK -------------------------------------------------------


def _delta(content=None, tool_calls=None, **kw) -> SimpleNamespace:
    """Delta-shaped object; the real SDK delta always carries these attributes."""
    fields = {"content": content, "tool_calls": tool_calls}
    fields.update(kw)
    return SimpleNamespace(**fields)


def _text_chunk(text: str) -> SimpleNamespace:
    """A ChatCompletionChunk-shaped object carrying one content delta. Every
    SDK choice always carries finish_reason (None mid-stream), so the fakes
    mirror that shape — the finish handler reads it on every chunk."""
    return SimpleNamespace(choices=[SimpleNamespace(delta=_delta(content=text), finish_reason=None)])


def _finish_chunk() -> SimpleNamespace:
    """A ChatCompletionChunk-shaped object carrying finish_reason=stop."""
    return SimpleNamespace(choices=[SimpleNamespace(delta=_delta(), finish_reason="stop")])


def _ok_stream():
    """A healthy SSE body: one text token, then the finish chunk."""
    yield _text_chunk("hi")
    yield _finish_chunk()


def _fail_stream():
    """An SSE body that dies (read timeout) before delivering its first chunk."""
    raise httpx2.ReadTimeout("timed out")
    yield  # pragma: no cover -- generator by construction


def _partial_then_fail():
    """An SSE body that delivers one token and then dies mid-stream."""
    yield _text_chunk("partial")
    raise httpx2.ReadTimeout("timed out")


class _FakeCompletions:
    def __init__(self, streams):
        self._streams = list(streams)
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        if kwargs.pop("stream", None) is not True:
            raise AssertionError("create() must be called with stream=True")
        if not self._streams:
            raise AssertionError("unexpected extra create() call")
        return self._streams.pop(0)()


def _client(max_retries: int, streams):
    c = OpenaiLlmClient(
        api_key="sk-test",
        base_url="http://localhost/v1",
        model="test-model",
        max_retries=max_retries,
    )
    comps = _FakeCompletions(streams)
    c.client = SimpleNamespace(chat=SimpleNamespace(completions=comps))
    return c, comps


def _collect(gen):
    """Drain a stream generator: (events, error-or-None)."""
    out = []
    error = None
    try:
        for ev in gen:
            out.append(ev)
    except LlmError as e:
        error = e
    return out, error


def main() -> int:
    oc_mod.time = SimpleNamespace(sleep=lambda _s: None)
    retryable_status = frozenset({429, 500, 502, 503, 504})

    # 1. classify: raw httpx2 transport errors -> retryable structured codes
    err = LlmError.classify(httpx2.ReadTimeout("timed out"), retryable_status)
    check(err.code == "timeout" and err.retryable, "read timeout -> retryable timeout")
    check(err.message == "Request timed out.", "read timeout -> clean message")
    err = LlmError.classify(httpx2.ConnectError("refused"), retryable_status)
    check(err.code == "connection" and err.retryable, "connect error -> retryable connection")
    err = LlmError.classify(httpx2.ReadError("reset"), retryable_status)
    check(err.code == "connection" and err.retryable, "read error -> retryable connection")
    err = LlmError.classify(RuntimeError("boom"), retryable_status)
    check(err.code == "unknown" and not err.retryable, "unexpected error stays non-retryable")
    check(err.message == "boom", "unexpected error keeps its message (LlmError.__str__ is empty)")

    # 2. pre-token failure retries transparently, announcing the attempt
    client, comps = _client(3, [_fail_stream, _ok_stream])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is None, "transient pre-token failure recovers after one retry")
    types = [e["type"] for e in evs]
    check(types == ["retry", "text", "finish"], "retry notice precedes the recovered stream")
    check(evs[0]["attempt"] == 1 and evs[0]["max"] == 3, "retry notice carries attempt/max")
    check("retrying (1/3)" in evs[0]["message"], "retry notice message names the attempt")
    check(comps.calls == 2, "exactly two requests were issued")
    check([e["delta"] for e in evs if e["type"] == "text"] == ["hi"], "no duplicated partial text")

    # 3. every attempt failing surfaces a clear, attempt-aware timeout
    client, comps = _client(2, [_fail_stream, _fail_stream])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check([e["type"] for e in evs] == ["retry"], "one retry notice before exhaustion")
    check(evs[0]["attempt"] == 1 and evs[0]["max"] == 2, "retry notice counts down the budget")
    check(err is not None and err.code == "timeout" and err.retryable, "exhaustion raises retryable timeout")
    check("after 2 attempts" in err.message, "exhaustion message states the attempt count")
    check(comps.calls == 2, "no extra request after exhaustion")

    # 4. a failure AFTER content was delivered raises immediately: restarting
    #    from scratch would re-emit "partial" and duplicate it in the transcript
    client, comps = _client(3, [_partial_then_fail])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check([e["type"] for e in evs] == ["text"], "partial token streamed before the failure")
    check(evs[0]["delta"] == "partial", "partial content was delivered once")
    check(err is not None and err.code == "timeout", "mid-stream failure raises instead of duplicating")
    check(comps.calls == 1, "no retry request after partial delivery")

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
