"""Stream-protocol checks for the LLM clients (no network).

Run: uv run python -m tests.llm_client_test

Covers the mid-stream transport-error fix shared by both wire protocols — the
retry policy lives in llm_clients/stream_runner.py, so its cases are exercised
through the chat client where they were first hit and through the responses
client in section 5. Both must classify a body-level httpx2 error as retryable,
restart the request with a visible {"type": "retry"} notice, mark that notice
discard=true when the dead attempt had already streamed output (the caller drops
it before the retry's events arrive, so nothing is duplicated), and report
exhaustion with a clear "after N attempts" message.

Section 5 also pins the responses protocol's format bridging: chat history ->
items + instructions, flat tools, and the typed event feed -> the same events
the chat client emits (reasoning / text / tool_call_start / tool_call_delta /
finish), so the loop, the UI and the transcript cannot tell the two apart.
"""

from __future__ import annotations

import sys
import threading
import time
from types import SimpleNamespace

import httpx2
import openai

# the streaming driver sleeps through backoff via `time.sleep`; swap in a no-op
# stub so the checks never actually wait (scoped to that module, not global time)
import agent.llm.llm_clients.stream_runner as runner_mod
from agent.llm.client import LlmError
from agent.llm.llm_clients.stream_runner import MAX_REDIAL_BACKOFF_S
from agent.llm.llm_clients.openai_client import OpenaiLlmClient
from agent.llm.llm_clients.openai_responses_client import (
    OpenaiResponsesLlmClient,
    to_responses_input,
    to_responses_tools,
)
from tests.testsupport import check

# one shared request object: constructed APIStatusError fakes need a response
# that carries the request they came from (the SDK reads response.request)
_REQ = httpx2.Request("POST", "http://localhost/v1/chat/completions")

# ---- fake openai SDK -------------------------------------------------------


def _status_error(status: int, message: str, code: str) -> openai.APIStatusError:
    """An HTTP failure shaped the way the SDK builds one: its str() is the
    provider's JSON repr, exactly what classify() has to see through."""
    body = {"error": {"message": message, "code": code}}
    return openai.APIStatusError(
        f"Error code: {status} - {body}", response=httpx2.Response(status, request=_REQ), body=body
    )


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
    """An SSE body that delivers one token and then dies mid-stream: the case
    whose retry notice has to carry discard=true."""
    yield _text_chunk("partial")
    raise httpx2.ReadTimeout("timed out")


def _sdk_error(cls, cause=None):
    """An openai wrapper error shaped the way the SDK raises it: the transport
    exception chained on with ``raise cls(request=...) from err`` (the SDK's own
    wording is the flat "Request timed out." / "Connection error.")."""
    err = cls(request=_REQ)
    err.__cause__ = cause
    return err


def _refused(cause=None, cls=None):
    """A request that never gets a response: the factory (``create()``) itself
    fails — connection refused / DNS / connect timeout, i.e. "the network is
    down". This is NOT a body-level failure: nothing was opened and no first
    chunk ever existed, so a retry cannot duplicate anything."""
    error = _sdk_error(cls or openai.APITimeoutError, cause or httpx2.ConnectTimeout("timed out"))

    def _fail():
        raise error

    return _fail


class _BlockedStream:
    """An SSE body parked in a read: next() blocks until close() interrupts it —
    the exact shape of the incident (Stop arrived while the thread sat inside a
    blocking socket read). What a real close raises is a raw transport error,
    which only the cancellation check may keep from becoming a retry."""

    instances: list["_BlockedStream"] = []

    def __init__(self) -> None:
        self.closed = False
        self._wake = threading.Event()
        _BlockedStream.instances.append(self)

    def __iter__(self) -> "_BlockedStream":
        return self

    def __next__(self) -> SimpleNamespace:
        if not self._wake.wait(timeout=10):
            raise AssertionError("the blocked read was never interrupted")
        raise httpx2.ReadError("connection closed under us")

    def close(self) -> None:
        self.closed = True
        self._wake.set()


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


# ---- fake Responses API ----------------------------------------------------
# The typed stream events are pydantic models in the SDK; every handler reads
# them by attribute, so attribute-carrying namespaces are a faithful stand-in.


class _ScriptStream:
    """A scripted feed shaped like what responses.create() really hands back:
    an iterable that is also closable. The SDK Stream's close() is what the
    cancellation guard uses to break a parked read, and _open() reads .close
    the moment create() returns — so a bare iter(list) (a list_iterator has no
    close) models only half the transport contract."""

    def __init__(self, events):
        self._it = iter(events)
        self.closed = False

    def __iter__(self) -> "_ScriptStream":
        return self

    def __next__(self):
        return next(self._it)

    def close(self) -> None:
        self.closed = True


class _FakeResponses:
    """The SDK's `client.responses`: one scripted event feed per create() call."""

    def __init__(self, streams):
        self._streams = list(streams)
        self.calls = 0
        self.kwargs: list[dict] = []

    def create(self, **kwargs):
        self.calls += 1
        if kwargs.get("stream") is not True:
            raise AssertionError("responses.create() must be called with stream=True")
        self.kwargs.append({k: v for k, v in kwargs.items() if k != "stream"})
        if not self._streams:
            raise AssertionError("unexpected extra responses.create() call")
        # a script is either a generator function (it can raise mid-stream) or a
        # plain list of events; either way it must come back closable, the way
        # the real Stream is
        script = self._streams.pop(0)
        return script() if callable(script) else _ScriptStream(script)


def _responses_client(max_retries, streams, reasoning_effort=None):
    c = OpenaiResponsesLlmClient(
        api_key="sk-test",
        base_url="http://localhost/v1",
        model="test-model",
        max_retries=max_retries,
        reasoning_effort=reasoning_effort,
    )
    fake = _FakeResponses(streams)
    c.client = SimpleNamespace(responses=fake)
    return c, fake


def _ev(etype: str, **fields) -> SimpleNamespace:
    """One typed Responses stream event."""
    return SimpleNamespace(type=etype, **fields)


def _call_item(name="grep", call_id="call_1", arguments="") -> SimpleNamespace:
    return SimpleNamespace(type="function_call", call_id=call_id, name=name, arguments=arguments)


def _text_item(text: str) -> SimpleNamespace:
    return SimpleNamespace(type="message", content=[SimpleNamespace(type="output_text", text=text)])


def _full_turn_events():
    """Reasoning + text + a function call announced as an item, then completed."""
    yield _ev("response.reasoning_text.delta", delta="weigh")
    yield _ev("response.output_text.delta", delta="hi")
    yield _ev("response.output_text.delta", delta="!")
    yield _ev("response.output_item.added", output_index=1, item=_call_item())
    yield _ev("response.function_call_arguments.delta", output_index=1, delta='{"path": "."}')
    yield _ev(
        "response.completed",
        response=SimpleNamespace(output=[_text_item("hi!"), _call_item(arguments='{"path": "."}')]),
    )


def _responses_fail_stream():
    """An SSE body that dies (read timeout) before delivering its first event."""
    raise httpx2.ReadTimeout("timed out")
    yield  # pragma: no cover -- generator by construction


def _responses_partial_then_fail():
    yield _ev("response.output_text.delta", delta="partial")
    raise httpx2.ReadTimeout("timed out")


def _check_responses_protocol() -> None:
    # 5a. history -> items + instructions; chat tool schemas -> flat tools
    messages = [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "looking",
            "tool_calls": [{"id": "call_1", "function": {"name": "grep", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "result"},
    ]
    instructions, items = to_responses_input(messages)
    check(instructions == "SYS", "system prompt becomes the top-level instructions")
    check(
        items
        == [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "looking"},
            {"type": "function_call", "call_id": "call_1", "name": "grep", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "call_1", "output": "result"},
        ],
        "history replays as items (message / function_call / function_call_output)",
    )
    check(to_responses_input([]) == ("", []), "empty history -> no instructions, no items")
    check(
        to_responses_tools(
            [{"type": "function", "function": {"name": "grep", "description": "d", "parameters": {"type": "object"}}}]
        )
        == [{"type": "function", "name": "grep", "parameters": {"type": "object"}, "description": "d"}],
        "tool schemas flatten (no nested function object)",
    )
    check(to_responses_tools([]) == [], "no tools -> empty list")

    # 5b. typed event feed -> the internal stream protocol
    client, fake = _responses_client(2, [_full_turn_events])
    evs, err = _collect(
        client.stream(messages, tools=[{"type": "function", "function": {"name": "grep", "parameters": {}}}])
    )
    check(err is None, "a healthy responses turn raises nothing")
    check(
        [e["type"] for e in evs] == ["reasoning", "text", "text", "tool_call_start", "tool_call_delta", "finish"],
        "events translate to reasoning/text/tool_call_start/tool_call_delta/finish",
    )
    check(evs[0]["delta"] == "weigh", "reasoning text streams to the reasoning channel")
    check([e["delta"] for e in evs if e["type"] == "text"] == ["hi", "!"], "visible text streams in order")
    check(evs[3]["id"] == "call_1" and evs[3]["name"] == "grep", "tool_call_start carries the announced call")
    check(evs[4]["delta"] == '{"path": "."}', "argument fragments stream as tool_call_delta")
    fin = evs[-1]
    check(fin["reason"] == "tool_calls" and fin["content"] == "hi!", "finish reports tool_calls + the turn's text")
    check(
        fin["tool_calls"] == [{"id": "call_1", "name": "grep", "arguments": '{"path": "."}'}],
        "finish aggregates the call's arguments",
    )
    sent = fake.kwargs[0]
    check(sent["store"] is False, "the request never retains the conversation server-side")
    check(sent["instructions"] == "SYS" and sent["input"] == items, "the request carries instructions + items")
    check("messages" not in sent, "chat-completions 'messages' is not sent to the responses endpoint")
    check(sent["tools"] == [{"type": "function", "name": "grep", "parameters": {}}], "tools go over flat")
    check("reasoning" not in sent, "no reasoning field when the knob is unset")

    # 5c. the effort knob maps onto the Responses API's own levels
    client, fake = _responses_client(1, [_full_turn_events], reasoning_effort="max")
    _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(fake.kwargs[0]["reasoning"] == {"effort": "high"}, "chat 'max' effort -> responses 'high'")
    client, fake = _responses_client(1, [_full_turn_events], reasoning_effort="low")
    _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(fake.kwargs[0]["reasoning"] == {"effort": "low"}, "shared effort levels pass through")

    # 5d. a buffering relay: the terminal event alone must still deliver the turn
    buffered = [
        [
            _ev(
                "response.completed",
                response=SimpleNamespace(output=[_text_item("whole"), _call_item(arguments="{}")]),
            )
        ]
    ]
    client, _ = _responses_client(1, buffered)
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is None and [e["type"] for e in evs] == ["finish"], "a delta-less stream still ends in one finish")
    check(evs[0]["content"] == "whole", "finish falls back to the Response's own text")
    check(evs[0]["tool_calls"][0]["name"] == "grep", "finish falls back to the Response's own calls")

    # 5e. item-level bookkeeping: done events win, keys survive a missing
    #     output_index, and an item is announced exactly once
    item_stream = [
        [
            _ev("response.output_item.added", item_id="item_7", item=_call_item(arguments="")),
            _ev("response.function_call_arguments.delta", item_id="item_7", delta='{"a"'),
            _ev("response.function_call_arguments.done", item_id="item_7", arguments='{"a": 1}'),
            _ev("response.output_item.done", item_id="item_7", item=_call_item(arguments='{"a": 1}')),
            _ev("response.completed", response=SimpleNamespace(output=[])),
        ]
    ]
    client, _ = _responses_client(1, item_stream)
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is None, "an event feed keyed by item_id (no output_index) streams fine")
    check(
        [e["type"] for e in evs] == ["tool_call_start", "tool_call_delta", "finish"],
        "the item is announced once, its deltas stay on the same key",
    )
    check(evs[0]["index"] == "item_7" and evs[1]["index"] == "item_7", "call and deltas share the item key")
    check(evs[-1]["tool_calls"][0]["arguments"] == '{"a": 1}', "the completed item's arguments win")

    # 5f. turn ends the loop's way: truncation -> length, refusal -> visible text
    truncated = [
        [
            _ev("response.output_text.delta", delta="half"),
            _ev(
                "response.incomplete",
                response=SimpleNamespace(
                    output=[_text_item("half")],
                    incomplete_details=SimpleNamespace(reason="max_output_tokens"),
                ),
            ),
        ]
    ]
    client, _ = _responses_client(2, truncated)
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is None and evs[-1]["type"] == "finish", "an incomplete turn still finishes")
    check(evs[-1]["reason"] == "length", "max_output_tokens -> reason 'length'")
    client, _ = _responses_client(1, [[_ev("response.refusal.delta", delta="no can do")]])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check([e["type"] for e in evs] == ["text", "finish"], "a refusal streams as visible content")
    check(evs[0]["delta"] == "no can do", "the refusal text reaches the user")
    check(
        err is None and evs[-1]["content"] == "no can do",
        "a feed cut before its terminal event still finishes with what arrived",
    )

    # 5g. provider-reported failures are terminal: no retry, provider's message
    failed = [
        [
            _ev(
                "response.failed",
                response=SimpleNamespace(error=SimpleNamespace(code="invalid_request_error", message="bad tool")),
            )
        ]
    ]
    client, fake = _responses_client(3, failed)
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(evs == [] and err is not None and err.code == "invalid_request_error", "response.failed raises with its code")
    check(err.retryable is False and "bad tool" in err.message, "the provider's message is surfaced as-is")
    check(fake.calls == 1, "a failed response is not retried")
    client, fake = _responses_client(3, [[_ev("error", code="server_error", message="boom")]])
    _, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is not None and err.code == "server_error" and not err.retryable, "a mid-stream error event raises")
    check(fake.calls == 1, "a mid-stream error event is not retried")

    # 5g.2 window overflow: normalized to the one code the loop compacts on, so
    #      the same overflow that chat completions survives cannot abort this run
    overflow = [
        [
            _ev(
                "response.failed",
                response=SimpleNamespace(
                    error=SimpleNamespace(
                        code="context_length_exceeded",
                        message="This model's maximum context length is 128000 tokens",
                    )
                ),
            )
        ]
    ]
    client, _ = _responses_client(3, overflow)
    _, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(
        err is not None and err.code == "context_window_exceeded" and not err.retryable,
        "a coded window overflow maps to context_window_exceeded",
    )
    check("maximum context length" in err.message, "the overflow message reaches the user")
    client, _ = _responses_client(
        3, [[_ev("error", code="invalid_request_error", message="maximum context length exceeded")]]
    )
    _, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(
        err is not None and err.code == "context_window_exceeded",
        "an uncoded overflow is recognized by its message too",
    )

    # 5h. the shared retry policy behaves identically through this client
    client, fake = _responses_client(3, [_responses_fail_stream, _full_turn_events])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is None and evs[0]["type"] == "retry", "a pre-event failure retries with a notice")
    check(evs[0]["attempt"] == 1 and evs[0]["max"] == 3, "the notice counts the attempt budget")
    check(evs[0]["discard"] is False, "a pre-event failure asks for no discard")
    check(fake.calls == 2, "exactly two responses.create() calls were issued")
    check([e["delta"] for e in evs if e["type"] == "text"] == ["hi", "!"], "no duplicated partial text after retry")
    client, fake = _responses_client(3, [_responses_partial_then_fail, _full_turn_events])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is None, "a mid-stream drop recovers on the next attempt here too")
    check(
        [e["type"] for e in evs][:2] == ["text", "retry"] and evs[1]["discard"] is True,
        "the partial text is followed by a discard notice",
    )
    check(
        [e["delta"] for e in evs if e["type"] == "text"] == ["partial", "hi", "!"],
        "the retried turn streams from its own start, nothing is re-emitted",
    )
    check(fake.calls == 2, "exactly one retry request was issued")
    client, fake = _responses_client(2, [_responses_fail_stream, _responses_fail_stream])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is not None and "after 2 attempts" in err.message, "exhaustion states the attempt count")


def main() -> int:
    runner_mod.time = SimpleNamespace(sleep=lambda _s: None)
    retryable_status = frozenset({429, 500, 502, 503, 504})

    # 1. classify: raw httpx2 transport errors -> retryable structured codes
    err = LlmError.classify(httpx2.ReadTimeout("timed out"), retryable_status)
    check(err.code == "timeout" and err.retryable, "read timeout -> retryable timeout")
    check("Read timed out" in err.message, "read timeout -> clean message")
    err = LlmError.classify(httpx2.ConnectTimeout("timed out"), retryable_status)
    check(err.code == "timeout" and err.retryable, "connect timeout -> retryable timeout")
    check("Connect timed out" in err.message, "connect timeout names its phase")
    err = LlmError.classify(httpx2.PoolTimeout("pool exhausted"), retryable_status)
    check("connection slot" in err.message, "pool timeout names its phase")
    built = OpenaiLlmClient(api_key="sk-test", base_url="http://localhost/v1", model="m")
    check(
        built.timeout.connect == 15.0 and built.timeout.read == 240.0 and built.timeout.write == 60.0,
        "timeout budgets split: tight connect, generous streaming read",
    )
    # the SDK's OWN retry loop must stay off: what it does inside create() is
    # invisible to the caller — no retry notice, no chip, just a frozen-looking
    # window through every backoff (the reported symptom: "is it dead or is it
    # retrying?"). The only retries allowed are the ones this loop announces.
    check(built.client.max_retries == 0, "the chat client never lets the SDK retry behind our back")
    responses_built = OpenaiResponsesLlmClient(api_key="sk-test", base_url="http://localhost/v1", model="m")
    check(responses_built.client.max_retries == 0, "the responses client never lets the SDK retry behind our back")
    err = LlmError.classify(httpx2.ConnectError("refused"), retryable_status)
    check(err.code == "connection" and err.retryable, "connect error -> retryable connection")
    err = LlmError.classify(httpx2.ReadError("reset"), retryable_status)
    check(err.code == "connection" and err.retryable, "read error -> retryable connection")
    err = LlmError.classify(RuntimeError("boom"), retryable_status)
    check(err.code == "unknown" and not err.retryable, "unexpected error stays non-retryable")
    check(err.message == "boom", "unexpected error keeps its message (LlmError.__str__ is empty)")

    # 1b. a window overflow is the one failure the loop answers by compacting:
    #     the provider's own wording must land on that code, not on api_error
    err = LlmError.classify(
        _status_error(400, "This model's maximum context length is 128000 tokens", "context_length_exceeded"),
        retryable_status,
    )
    check(
        err.code == "context_window_exceeded" and not err.retryable,
        "chat 400 context overflow -> context_window_exceeded",
    )
    check("maximum context length" in err.message, "the overflow message reaches the user")
    err = LlmError.classify(_status_error(400, "bad tool schema", "invalid_request_error"), retryable_status)
    check(err.code == "api_error", "an unrelated 400 is not mistaken for an overflow")

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

    # 2b. the request never lands at all ("cannot connect to the network"):
    #     the factory itself raises — the SDK wraps the connect timeout /
    #     connection error, no body was ever opened. Exactly as retryable as a
    #     body-level drop, and it MUST be announced: without the notice the user
    #     stares at a frozen window through the whole connect budget with no way
    #     to tell "still working" from "dead".
    client, comps = _client(3, [_refused(), _ok_stream])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is None and comps.calls == 2, "a refused request is retried and recovers")
    check([e["type"] for e in evs] == ["retry", "text", "finish"], "the refused attempt is announced before retrying")
    check("Connect timed out" in evs[0]["message"], "the notice names the connect phase, not a bare 'timed out'")
    check("retrying (1/3)" in evs[0]["message"], "the notice counts the attempt")
    client, comps = _client(2, [_refused(), _refused()])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check([e["type"] for e in evs] == ["retry"], "one notice before exhaustion, not a silent death")
    check(err is not None and err.code == "timeout" and err.retryable,
          "an unreachable endpoint raises a retryable timeout")
    check("after 2 attempts" in err.message, "exhaustion states the attempt count for an unreachable endpoint")
    check(comps.calls == 2, "no extra request after exhaustion")
    # a refused connection (the other wrapper) is retryable too, and names the cause
    client, comps = _client(2, [_refused(httpx2.ConnectError("refused"), openai.APIConnectionError), _ok_stream])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is None and evs[0]["code"] == "connection", "a connection error at request time is retryable")
    check("Cannot reach the API endpoint" in evs[0]["message"],
          "the notice says what failed instead of 'Connection error.'")
    # Stop still wins over a request-time failure
    client, comps = _client(3, [_refused(), _ok_stream])
    cancel = threading.Event()
    cancel.set()
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}], cancel=cancel))
    check(evs == [] and comps.calls == 0 and err is not None and err.code == "cancelled",
          "a pre-set Stop never issues (or retries) a request")

    # 3. every attempt failing surfaces a clear, attempt-aware timeout
    client, comps = _client(2, [_fail_stream, _fail_stream])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check([e["type"] for e in evs] == ["retry"], "one retry notice before exhaustion")
    check(evs[0]["attempt"] == 1 and evs[0]["max"] == 2, "retry notice counts down the budget")
    check(err is not None and err.code == "timeout" and err.retryable, "exhaustion raises retryable timeout")
    check("after 2 attempts" in err.message, "exhaustion message states the attempt count")
    check(comps.calls == 2, "no extra request after exhaustion")

    # 4. a failure AFTER content was delivered is retried too: the attempt's
    #    partial output is announced as discard=true, which tells the caller to
    #    throw it away before the retry's events arrive — so a drop in the middle
    #    of an answer costs a reconnect instead of duplicating the text
    client, comps = _client(3, [_partial_then_fail, _ok_stream])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(err is None, "a mid-stream drop recovers on the next attempt")
    check(
        [e["type"] for e in evs] == ["text", "retry", "text", "finish"],
        "partial text, then the discard notice, then the retried turn",
    )
    check(evs[0]["delta"] == "partial", "the dead attempt's text reached the caller once")
    check(evs[1]["discard"] is True, "the notice tells the caller to drop that partial output")
    check(evs[1]["attempt"] == 1 and evs[1]["max"] == 3, "the notice counts the attempt budget")
    check("retrying (1/3)" in evs[1]["message"], "the notice names the attempt")
    check(evs[2]["delta"] == "hi", "the retried attempt streams its own answer from the start")
    check(comps.calls == 2, "exactly two requests were issued")

    # 4a. nothing delivered yet: the notice asks for no discard
    client, comps = _client(3, [_fail_stream, _ok_stream])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check([e["type"] for e in evs] == ["retry", "text", "finish"], "a pre-token failure retries with a notice")
    check(evs[0]["discard"] is False, "nothing reached the caller, so the notice asks for no drop")

    # 4b. mid-stream drops that outlast the budget still surface a clear error
    client, comps = _client(2, [_partial_then_fail, _partial_then_fail])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check(
        [e["type"] for e in evs] == ["text", "retry", "text"],
        "each attempt delivers its partial before the next notice",
    )
    check(err is not None and err.code == "timeout", "a mid-stream drop that never recovers raises")
    check("after 2 attempts" in err.message, "exhaustion after mid-stream drops states the attempt count")
    check(comps.calls == 2, "no extra request after exhaustion")

    # 4c. cancellation: Stop must reach every waiting point of a turn — the
    #     attempt's top, a read blocked mid-attempt, and the retry backoff —
    #     because cancel is otherwise only observable between chunks.
    # pre-set Stop: no request at all
    client, comps = _client(3, [_ok_stream])
    cancel = threading.Event()
    cancel.set()
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}], cancel=cancel))
    check(evs == [] and err is not None and err.code == "cancelled" and not err.retryable,
          "a pre-set Stop raises cancelled without streaming")
    check(comps.calls == 0, "a pre-set Stop never issues a request")
    # Stop lands while the thread sits in a blocked read: the guard closes the
    # connection from outside, the read raises now (not at the 240s read budget)
    _BlockedStream.instances.clear()
    client, comps = _client(3, [_BlockedStream])
    cancel = threading.Event()
    threading.Timer(0.5, cancel.set).start()
    started = time.monotonic()
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}], cancel=cancel))
    elapsed = time.monotonic() - started
    check(err is not None and err.code == "cancelled" and not err.retryable,
          "a Stop mid-read raises cancelled, not a transport error")
    check(comps.calls == 1, "a guard-killed attempt is never retried")
    check(_BlockedStream.instances and _BlockedStream.instances[0].closed, "the guard closed the blocked stream")
    check(elapsed < 5, f"the blocked read was interrupted promptly (took {elapsed:.2f}s)")
    # Stop lands during the retry backoff: the wait breaks off, no second attempt
    client, comps = _client(3, [_fail_stream, _ok_stream])
    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()  # attempt 0 fails instantly; backoff for it is 1s
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}], cancel=cancel))
    check(err is not None and err.code == "cancelled", "a Stop during backoff cancels instead of retrying")
    check(comps.calls == 1, "no second request after a cancelled backoff")
    check([e["type"] for e in evs] == ["retry"], "the retry notice was already out when Stop landed")

    # 4d. the redial ladder and the unbounded budget. Giving up after a couple of
    #     attempts is what made a tunnel reconnect useless: the counterparty is the
    #     CLIENT's proxy, so the redial has to outlast the outage. The ladder is
    #     1,2,4,...,128s and then HOLDS at 128s — doubling keeps a long budget cheap,
    #     holding keeps a long outage from turning into a once-an-hour probe — and
    #     max_retries <= 0 means "keep redialing until the run's own Stop".
    class _CountingStop:
        """A duck-typed Stop that trips on the Nth backoff: walks the whole ladder
        with no thread and no real waiting."""
        def __init__(self, trip_after: int) -> None:
            self.waits: list[float] = []
            self._trip = trip_after
        def is_set(self) -> bool:
            return False  # only wait() ever trips it
        def wait(self, delay: float) -> bool:
            self.waits.append(delay)
            return len(self.waits) >= self._trip

    ladder = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0]
    held = ladder + [MAX_REDIAL_BACKOFF_S] * 3  # 1,2,4,...,128,128,128,128
    waited: list[float] = []
    real_time = runner_mod.time
    runner_mod.time = SimpleNamespace(sleep=waited.append)
    try:
        # bounded: the ladder climbs, then holds, and exhaustion still says so
        client, comps = _client(12, [_fail_stream] * 12)
        evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    finally:
        runner_mod.time = real_time
    check(waited == held, f"a fixed budget walks the ladder and holds at the cap (got {waited})")
    check([e["type"] for e in evs] == ["retry"] * 11, "every redial before the cap is announced")
    check(evs[0]["max"] == 12 and "retrying (1/12)" in evs[0]["message"], "a fixed budget shows its count")
    check(err is not None and "after 12 attempts" in err.message, "a fixed budget still says when it gave up")
    check(comps.calls == 12, "a fixed budget issues exactly its attempts")
    # unbounded: same ladder, no give-up, and the Stop is the only thing that ends it
    stop = _CountingStop(trip_after=11)
    client, comps = _client(0, [_fail_stream] * 11)
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}], cancel=stop))
    check(stop.waits == held, f"an unbounded redial climbs the same ladder and holds at the cap (got {stop.waits})")
    check(comps.calls == 11, "each backoff bought one more attempt, right up to the Stop")
    check(err is not None and err.code == "cancelled", "nothing but the Stop ends an unbounded redial")
    check([e["type"] for e in evs] == ["retry"] * 11, "every unbounded redial is announced too")
    check(evs[0]["max"] == 0 and "retrying (1/…)" in evs[0]["message"],
          "with no fixed budget the notice shows an open-ended count instead of a lie")
    check("retrying (11/…)" in evs[-1]["message"], "the open-ended notice keeps counting up")

    # 5. responses protocol: the same contract over a different wire format
    _check_responses_protocol()

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
