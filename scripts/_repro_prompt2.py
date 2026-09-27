import sys
sys.path.insert(0,'.')
from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.prompts import render
raw=open('school.clc','rb').read()
base=raw.find(b'---\n')+4
events=[(o,e) for o,e in _parse_with_offsets(raw[base:]+b'\n',0)]
comps=[i for i,(o,e) in enumerate(events) if e.type=='compaction']
k=3
ci=comps[k]; start=comps[k-1]
prev_off=events[start][0]; cur_off=events[ci][0]
window=[e for o,e in events if prev_off<=o<cur_off]
prev=events[comps[k-1]][1].summary
comp=Compactor(Config(), LazyEventLog.in_memory(), None)
text=comp._serialize(window)
prompt=render("compaction.md", history=text, previous_summary=prev or "(none)")
print("PROMPT len:", len(prompt))
print("======= HEAD 1500 =======")
print(prompt[:1500])
print("======= TAIL 2500 =======")
print(prompt[-2500:])
