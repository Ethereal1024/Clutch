"""Probe the configured LLM endpoint with the compaction prompt (diagnostic).

Usage: PYTHONPATH=. .venv/bin/python scripts/_probe_llm.py [model_override]

Prints the raw streamed events for a compaction-style request, so we can see
whether an agentic model CONTINUES the transcript instead of summarizing it.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
model = sys.argv[1] if len(sys.argv) > 1 else cfg["model"]
print("base_url:", cfg["base_url"], "model:", model)

os.environ["CLUTCH_API_KEY"] = cfg["api_key"]
os.environ["CLUTCH_BASE_URL"] = cfg["base_url"]
os.environ["CLUTCH_MODEL"] = model

from agent.base import BaseServer  # noqa: E402
from agent.config import Config  # noqa: E402


class _S(BaseServer):
    def build_workspace(self, project):  # pragma: no cover
        raise NotImplementedError


# minimal: just build the client directly
from agent.llm.factory import build_client  # noqa: E402

client = build_client(api_key=cfg["api_key"], model=model, base_url=cfg["base_url"])

# A tiny transcript that ends mid-action, exactly like a real window tail.
history = (
    "[User]: 找出这个 bug 的根因\n"
    "[Assistant]: Let me look at the code.\n"
    "[Assistant tool call]: run_command({'command': 'grep -n foo bar.py'})\n"
    "[Tool result]: OK: command succeeded\nstdout:\n12:foo = 1\n"
)
prompt = (
    "Output exactly the Markdown structure shown inside <template> and keep the section order unchanged.\n"
    "<template>\n## Objective\n- [what the user wants]\n\n## Next Move\n1. [next action]\n</template>\n\n"
    "Prior summary:\n(none)\n\n<conversation>\n" + history + "</conversation>\n"
)
events = []
for ev in client.stream([{"role": "user", "content": prompt}], tools=None, cancel=None):
    events.append(ev)
    if len(events) > 400:
        break
print("event types:", [e["type"] for e in events][:80])
text = "".join(e.get("delta", "") for e in events if e["type"] == "text")
reasoning = "".join(e.get("delta", "") for e in events if e["type"] == "reasoning")
print("\n--- TEXT (%d chars) ---" % len(text))
print(text[:2000])
print("\n--- REASONING (%d chars) ---" % len(reasoning))
print(reasoning[:1500])
