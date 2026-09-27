"""Duck-injection lab: why does compaction lose a past requirement?

The Compactor talks to an LlmClient through one duck-typed method (`stream()`
yielding the event protocol). A fake client — no network, no model, no
threading — RECORDS the exact prompt compaction sends and PLAYS BACK a summary.
The prompt is the only input a summary can be built from, so anything missing
there is missing from the summary the conversation continues on. The same trick
drives derive_messages (the context builder), so both halves of the pipeline
run headless.

Scenarios:
  A. over-budget window: is the user's original request still in the prompt the
     summarizer receives? (the old tail-only cap cut it off the head)
  B. chain: does a faithful summary carry the objective across two compactions?
  C. continued session: does a second user message drop the first one from the
     model-visible context? (the index-0 "raw task" skip did)

Exits non-zero if a HOST invariant regresses, so it can gate CI.

Run: PYTHONPATH=. .venv/bin/python scripts/_compact_lab.py
"""

from __future__ import annotations

import re
import sys

from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.context import derive_messages
from agent.core.lazy import LazyEventLog
from agent.events import AssistantMessageEvent, UserMessageEvent

REQUIREMENT = "所有日志改成单行 JSON，并且不要动 ui/ 目录"
FOLLOW_UP = "继续"
WINDOW = 200_000

_failures: list[str] = []


class RecordingSummarizer:
    """Duck-typed LlmClient: records every prompt, replies with `reply`.

    `faithful=True` plays a compliant model: it extracts the objective line the
    prompt carried and echoes it back inside the template, so the chain test
    measures the HOST plumbing, not model quality."""

    def __init__(self, reply: str = "## Objective\n- (stub)", faithful: bool = False) -> None:
        self.reply = reply
        self.faithful = faithful
        self.prompts: list[str] = []

    def stream(self, msgs, tools=None, cancel=None):
        prompt = msgs[0]["content"]
        self.prompts.append(prompt)
        reply = self.reply
        if self.faithful:
            m = re.search(r"^\[User\]: (.*)$", prompt, re.MULTILINE)
            reply = f"## Objective\n- {m.group(1) if m else '(none)'}"
        yield {"type": "text", "delta": reply}
        yield {"type": "finish", "reason": "stop"}


def bulked(notes: int, size: int) -> LazyEventLog:
    """A window that is mostly assistant bulk: the user's request is the FIRST
    event (where framing always lives), everything after it is noise."""
    log = LazyEventLog.in_memory()
    log.append(UserMessageEvent(content=REQUIREMENT))
    for i in range(notes):
        log.append(AssistantMessageEvent(content=f"note {i} " + "a" * size))
    return log


def over_budget(bulk_bytes: int = 204_000) -> LazyEventLog:
    """A slightly over-window session whose serialization still exceeds the
    summary prompt's cap — the only regime where truncation fires. Few large
    events (low per-event JSON overhead) reproduce it honestly."""
    log = LazyEventLog.in_memory()
    log.append(UserMessageEvent(content=REQUIREMENT))
    chunk = 20_000
    written = 0
    i = 0
    while written < bulk_bytes:
        log.append(AssistantMessageEvent(content=f"[{i}]" + "a" * chunk))
        written += chunk
        i += 1
    return log


def compact_capture(log: LazyEventLog, summarizer: RecordingSummarizer) -> tuple[str, str]:
    comp = Compactor(Config(llm_context_window_bytes=WINDOW), log, summarizer)  # type: ignore[arg-type]
    ok = comp.compact()
    prompt = summarizer.prompts[-1] if summarizer.prompts else ""
    summary = log.last_compaction().summary if log.last_compaction() else ""
    return prompt, (summary if ok else f"<no compaction: {ok}>")


def verify(title: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS: ' if ok else 'FAIL: '} {title}")
    if detail:
        print(f"       {detail}")
    if not ok:
        _failures.append(title)


def scenario_a() -> None:
    print("\n=== A. over-budget window: does the summary prompt keep the request? ===")
    log = over_budget()
    summarizer = RecordingSummarizer()
    prompt, _ = compact_capture(log, summarizer)
    elided = "[... earlier transcript elided ...]" in prompt
    print(f"window bytes: {log.window_bytes() + len(REQUIREMENT):,}   prompt bytes: {len(prompt.encode()):,}")
    print(f"prompt mentions the request: {REQUIREMENT in prompt}   elision marker: {elided}")
    verify(
        "the summary prompt carries the session's original request",
        REQUIREMENT in prompt,
        "" if REQUIREMENT in prompt else "the request was cut off the head of the history",
    )


def scenario_b() -> None:
    print("\n=== B. does the objective survive two compactions? ===")
    log = over_budget()
    summarizer = RecordingSummarizer(faithful=True)
    compact_capture(log, summarizer)
    first_ok = REQUIREMENT in (log.last_compaction().summary if log.last_compaction() else "")
    # grow the window again and compact a second time: the objective must ride
    # the previous-summary channel, not the (now short) live window
    compact_capture(log, summarizer)
    second = log.last_compaction().summary if log.last_compaction() else ""
    carried = "Prior summary:" in summarizer.prompts[-1] and REQUIREMENT in summarizer.prompts[-1]
    print(f"summary #1 carries the request: {first_ok}")
    print(f"compaction #2 prompt carries it via <prior-summary>: {carried}")
    print(f"final summary: {second[:80]!r}")
    verify(
        "the objective survives a second compaction",
        first_ok and carried and REQUIREMENT in second,
        "" if (first_ok and carried) else "the previous summary channel dropped the objective",
    )


def scenario_c() -> None:
    print("\n=== C. continued session: does a second message drop the first? ===")
    log = LazyEventLog.in_memory()
    log.append(UserMessageEvent(content=REQUIREMENT))
    log.append(AssistantMessageEvent(content="work"))
    log.append(UserMessageEvent(content=FOLLOW_UP))
    msgs = derive_messages(log, Config(), FOLLOW_UP, None, None)
    body = "\n".join(str(m.get("content", "")) for m in msgs)
    print("model-visible roles:", [m["role"] for m in msgs])
    verify(
        "the first user message survives a later run in the same project",
        REQUIREMENT in body,
        "" if REQUIREMENT in body else "the log's first user message was dropped from the context",
    )


if __name__ == "__main__":
    scenario_a()
    scenario_b()
    scenario_c()
    print()
    if _failures:
        print(f"{len(_failures)} host invariant(s) regressed: {_failures}")
        sys.exit(1)
    print("all host invariants hold")
