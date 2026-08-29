from abc import ABC, abstractmethod
from typing import Any

from openai.types.chat import ChatCompletionChunk


class StreamState:
    def __init__(self):
        self.content_parts: list[str] = []
        self.tool_args: dict[int, dict[str, Any]] = {}
        self.finished: bool = False
        self.finish_reason: str | None = None


class ChunkHandler(ABC):
    @abstractmethod
    def handle(self, chunk: ChatCompletionChunk, state: StreamState) -> list[dict[str, Any]]: ...


class ReasoningHandler(ChunkHandler):
    def handle(self, chunk: ChatCompletionChunk, state: StreamState) -> list[dict[str, Any]]:
        events = []
        delta = getattr(chunk.choices[0], "delta", None) if chunk.choices else None
        if delta:
            reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
            if reasoning:
                events.append({"type": "reasoning", "delta": reasoning})
        return events


class ContentHandler(ChunkHandler):
    def handle(self, chunk: ChatCompletionChunk, state: StreamState) -> list[dict[str, Any]]:
        delta = getattr(chunk.choices[0], "delta", None) if chunk.choices else None
        if not delta or not delta.content:
            return []
        events = []
        state.content_parts.append(delta.content)
        events.append({"type": "text", "delta": delta.content})
        return events


class ToolCallHandler(ChunkHandler):
    def handle(self, chunk: ChatCompletionChunk, state: StreamState) -> list[dict[str, Any]]:
        delta = getattr(chunk.choices[0], "delta", None) if chunk.choices else None
        if not delta or not delta.tool_calls:
            return []

        events = []
        for tc in delta.tool_calls:
            idx = tc.index
            if idx not in state.tool_args:
                state.tool_args[idx] = {
                    "id": tc.id or "",
                    "name": (tc.function.name if tc.function else "") or "",
                    "args": "",
                }
                events.append(
                    {
                        "type": "tool_call_start",
                        "index": idx,
                        "id": state.tool_args[idx]["id"],
                        "name": state.tool_args[idx]["name"],
                    }
                )

            entry = state.tool_args[idx]
            if tc.id:
                entry["id"] = tc.id
            if tc.function:
                if tc.function.name:
                    entry["name"] = tc.function.name
                if tc.function.arguments:
                    entry["args"] += tc.function.arguments
                    events.append(
                        {
                            "type": "tool_call_delta",
                            "index": idx,
                            "delta": tc.function.arguments,
                        }
                    )
        return events


class FinishHandler(ChunkHandler):
    def handle(self, chunk: ChatCompletionChunk, state: StreamState) -> list[dict[str, Any]]:
        choice = chunk.choices[0] if chunk.choices else None
        if not choice or not choice.finish_reason:
            return []

        events = []
        state.finished = True
        state.finish_reason = choice.finish_reason
        tool_calls = [
            {"id": entry["id"], "name": entry["name"], "arguments": entry["args"]} for entry in state.tool_args.values()
        ]
        events.append(
            {
                "type": "finish",
                "reason": choice.finish_reason,
                "content": "".join(state.content_parts),
                "tool_calls": tool_calls,
            }
        )
        return events


def get_default_handlers():
    return [ReasoningHandler(), ContentHandler(), ToolCallHandler(), FinishHandler()]
