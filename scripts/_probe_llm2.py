"""Probe the configured LLM with the REAL compaction prompt (diagnostic)."""
import json, sys
from pathlib import Path
cfg = json.loads((Path.home()/".clutch"/"settings.json").read_text())
print("model:", cfg.get("model"), "base_url:", cfg.get("base_url"), "protocol:", cfg.get("api_protocol"))
sys.path.insert(0,'.')
from agent.llm.factory import create_llm_client
from agent.prompts import render
client = create_llm_client(api_key=cfg["api_key"], model=cfg["model"],
                           base_url=cfg["base_url"], protocol=cfg.get("api_protocol"))

history = (
    "[User]: 找出这个 bug 的根因\n"
    "[Assistant]: Let me look at the code.\n"
    "[Assistant tool call]: run_command({'command': 'grep -n foo bar.py'})\n"
    "[Tool result]: OK: command succeeded\nstdout:\n12:foo = 1\n"
)
prompt = render("compaction.md", history=history, previous_summary="(none)")
print("=== prompt tail ===\n", prompt[-400:])
evs=[]
for ev in client.stream([{"role":"user","content":prompt}], tools=None, cancel=None):
    evs.append(ev)
    if len(evs) > 2000: break
print("\nevent types:", [e["type"] for e in evs][:20], "...", len(evs))
text="".join(e.get("delta","") for e in evs if e["type"]=="text")
reas="".join(e.get("delta","") for e in evs if e["type"]=="reasoning")
print("\n--- TEXT (%d) ---\n%s" % (len(text), text[:1500]))
print("\n--- REASONING (%d) ---\n%s" % (len(reas), reas[:800]))
