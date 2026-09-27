"""End-to-end compaction cycle on a REAL .clc file (persistence included)."""
import sys, tempfile, os
from pathlib import Path
sys.path.insert(0, '.')
from agent.project import create_project, open_project_lazy
from agent.events import UserMessageEvent, AssistantMessageEvent
from agent.core.compaction import Compactor
from agent.core.context import derive_messages
from agent.config import Config

class FakeLlm:
    def stream(self, msgs, tools=None, cancel=None):
        yield {"type": "text", "delta": "## Objective\n- keep the ORIGINAL REQUEST\n"}
        yield {"type": "finish", "reason": "stop"}

d = Path(tempfile.mkdtemp())
p = create_project(d / "t.clc", "t", "m")
log = p.log
log.append(UserMessageEvent(content="ORIGINAL REQUEST"))
for i in range(40):
    log.append(AssistantMessageEvent(content=f"turn {i} " + "x"*500))

cfg = Config(llm_context_window_bytes=5000)
comp = Compactor(cfg, log, FakeLlm())
print("should_compact:", comp.should_compact(), "window_bytes:", log.window_bytes())
print("compact ->", comp.compact())
print("after compact cpr_start:", log.cpr_start(), "window_bytes:", log.window_bytes())
path = p.path
del p
# reopen from disk
p2 = open_project_lazy(path)
log2 = p2.log
print("reopened cpr_start:", log2.cpr_start(), "window_bytes:", log2.window_bytes(), "events:", len(log2.events()))
for off, ev in log2.items():
    print(" ", off, ev.type, repr(str(getattr(ev, 'summary', getattr(ev, 'content', '')))[:50]))
msgs = derive_messages(log2, cfg, "ORIGINAL REQUEST")
print("derived", len(msgs), "messages")
for m in msgs:
    print(" -", m["role"], repr(str(m.get("content"))[:80]))
print()
print("SUMMARY IN CONTEXT:", any("keep the ORIGINAL REQUEST" in str(m.get('content','')) for m in msgs))
