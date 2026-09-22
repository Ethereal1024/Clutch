"""Stream-protocol checks for the LLM clients (no network).

Run: uv run python -m tests.llm_client_test

Covers the mid-stream transport-error fix shared by both wire protocols — the
retry policy lives in llm_clients/stream_runner.py, so its cases are exercised
through the chat client where they were first hit and through the responses
client in section 5. Both must classify a body-level httpx2 error as retryable,
restart the request (with a visible {"type": "retry"} notice) only when nothing
of the attempt reached the caller, raise immediately instead of re-streaming
duplicated content once it did, and report exhaustion with a clear "after N
attempts" message.

Section 5 also pins the responses protocol's format bridging: chat history ->
items + instructions, flat tools, and the typed event feed -> the same events
the chat client emits (reasoning / text / tool_call_start / tool_call_delta /
finish), so the loop, the UI and the transcript cannot tell the two apart.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace

import httpx2
import openai

# the streaming driver sleeps through backoff via `time.sleep`; swap in a no-op
# stub so the checks never actually wait (scoped to that module, not global time)
import agent.llm.llm_clients.stream_runner as runner_mod
from agent.llm.client import LlmError
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


# ---- fake Responses API ----------------------------------------------------
# The typed stream events are pydantic models in the SDK; every handler reads
# them by attribute, so attribute-carrying namespaces are a faithful stand-in.


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
        # plain list of events
        script = self._streams.pop(0)
        return script() if callable(script) else iter(script)


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
    yield _ev("response.completed", response=SimpleNamespace(output=[_text_item("hi!"), _call_item(arguments='{"path": "."}')]))


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
    check(fake.calls == 2, "exactly two responses.create() calls were issued")
    check([e["delta"] for e in evs if e["type"] == "text"] == ["hi", "!"], "no duplicated partial text after retry")
    client, fake = _responses_client(3, [_responses_partial_then_fail])
    evs, err = _collect(client.stream([{"role": "user", "content": "hi"}]))
    check([e["type"] for e in evs] == ["text"], "partial text is delivered once")
    check(err is not None and err.code == "timeout" and fake.calls == 1, "mid-stream failure raises instead of duplicating")
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

    # 5. responses protocol: the same contract over a different wire format
    _check_responses_protocol()

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
