"""Reconstruct the compaction prompt each real compaction in school.clc received."""
import json, sys
sys.path.insert(0,'.')
from agent.config import Config
from agent.core.compaction import Compactor
from agent.core.lazy import LazyEventLog, _parse_with_offsets
from agent.events import event_from_dict, DURABLE_TYPES
from agent.prompts import render

path='school.clc'
raw=open(path,'rb').read()
# event region start
import re
sep = raw.find(b'---\n')
base = sep+4
region = raw[base:]
events = [(off, ev) for off, ev in _parse_with_offsets(region+b'\n', 0)]
print("events:", len(events), "config window:", Config().llm_context_window_bytes)

# find compaction indices
comps = [i for i,(o,e) in enumerate(events) if e.type=='compaction']
print("compaction indices:", comps)
for k, ci in enumerate(comps):
    start = 0 if k==0 else comps[k-1]
    # window = events from previous compaction offset to this compaction (exclusive)
    prev_off = events[start][0]
    cur_off = events[ci][0]
    window = [e for o,e in events if prev_off <= o < cur_off]
    prev_summary = events[comps[k-1]][1].summary if k>0 else ""
    log = LazyEventLog.in_memory()
    # emulate cpr_start/window_bytes via a fake file
    comp = Compactor(Config(), log, None)  # type: ignore
    # monkey: feed _serialize and cap
    text = comp._serialize(window)
    cap = Config().llm_context_window_bytes - len(prev_summary.encode()) - 8192
    s = events[ci][1].summary
    print(f"\n--- compaction #{k} (event idx {ci}, window {len(window)} evs, {cur_off-prev_off} bytes)")
    print(f"    summary len={len(s)}  starts: {s[:90]!r}")
    print(f"    prev_summary len={len(prev_summary)}  cap={cap}  serialized len={len(text)}  truncated={'[... earlier' in text}")
    print(f"    has '## Objective' in summary: {'## Objective' in s}")
