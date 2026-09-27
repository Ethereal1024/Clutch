"""Feed the REAL model a reconstructed compaction prompt from school.clc."""
import json, sys
from pathlib import Path
cfg = json.loads((Path.home()/".clutch"/"settings.json").read_text())
sys.path.insert(0,'.')
from agent.llm.factory import create_llm_client
from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render
client = create_llm_client(api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol"))
raw=open('school.clc','rb').read()
base=raw.find(b'---\n')+4
events=[(o,e) for o,e in _parse_with_offsets(raw[base:]+b'\n',0)]
comps=[i for i,(o,e) in enumerate(events) if e.type=='compaction']
k=int(sys.argv[1]) if len(sys.argv)>1 else 3
ci=comps[k]; start=comps[k-1]
window=[e for o,e in events if events[start][0]<=o<events[ci][0]]
prev=events[comps[k-1]][1].summary
comp=Compactor(Config(), LazyEventLog.in_memory(), client)
text=comp._serialize(window)
prompt=render("compaction.md", history=text, previous_summary=prev or "(none)")
print("prompt chars:", len(prompt), "window events:", len(window))
evs=[]
try:
    for ev in client.stream([{"role":"user","content":prompt}], tools=None, cancel=None):
        evs.append(ev)
        if len(evs)>5000: break
except Exception as e:
    print("ERROR:", type(e).__name__, getattr(e,'code',None), getattr(e,'message',None) or e)
    sys.exit(0)
print("event types sample:", [e["type"] for e in evs][:10], "total", len(evs))
text_out="".join(e.get("delta","") for e in evs if e["type"]=="text")
print("TEXT len:", len(text_out))
print(text_out[:1200])
