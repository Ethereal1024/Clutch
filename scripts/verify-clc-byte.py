"""Verify converted .clc files open correctly under the byte-addressed reader:
lazy load active (resident < total durable), every compaction tail_start points
at a real line start, and derive / tail_start_index match a fully loaded log.

Run: uv run python scripts/tmp-verify-converted.py
"""
import json
import sys
from pathlib import Path

from agent.config import Config
from agent.core.context import derive_messages
from agent.core.lazy import _make_reader, _tail_scan
from agent.events import DURABLE_TYPES, EventLog, event_from_dict
from agent.project import _event_region_start, open_project_lazy

FILES = ["api-fix.clc", "lazy-load.clc", "pack.clc", "chat-test.clc"]
ok = True


def check(cond, label):
    global ok
    print(("ok:  " if cond else "FAIL: ") + label)
    ok = ok and cond


def load_full(path: Path) -> EventLog:
    """Fully load a .clc into an EventLog with real file-based byte offsets
    relative to the event region (the raw task's line start = 0). Every line
    inside the region occupies bytes (transients, [memories] section, even
    events appended after the memory section); only durable events get offsets
    recorded, aligned 1:1 with _durable()."""
    log = EventLog()
    text = path.read_text(encoding="utf-8")
    running = 0
    in_region = False
    for line in text.split("\n"):
        s = line.strip()
        if s:
            try:
                data = json.loads(line)
            except (ValueError, TypeError, json.JSONDecodeError):
                data = None
            if isinstance(data, dict) and data.get("type") in DURABLE_TYPES:
                if not in_region:
                    in_region = True
                    log._offsets.append(0)  # the raw task: event region start
                else:
                    log._offsets.append(running)
                log._events.append(event_from_dict(data))
        if in_region:
            running += len(line.encode("utf-8")) + 1  # BYTES of every line inside the region
    return log


def main() -> None:
    for name in FILES:
        p = Path(name)
        print(f"--- {name}")
        proj = open_project_lazy(p, workspace=None)
        log = proj.log
        check(type(log).__name__ in ("LazyEventLog", "EventLog"), f"opens as {type(log).__name__}")
        full = load_full(p)
        ndur = len([e for e in full.events() if e.type in DURABLE_TYPES])
        resident = len(log.events())
        if type(log).__name__ == "LazyEventLog":
            check(resident < ndur, f"lazy load ACTIVE (resident {resident} < durable {ndur})")
            # every materialized offset points at a real line start
            read, total = _make_reader(p, None)
            head = read(0, min(total, 1 << 16))
            base = _event_region_start(head) or 0
            raw = p.read_bytes()
            check(
                all(raw[base + off : base + off + 1] == b"{" for off, _ in log.items() if off > 0),
                "all materialized offsets are real line starts",
            )
            # tail_start_index EXACTLY matches the full log
            w = full.tail_start_index(3000)
            g = log.tail_start_index(3000)
            check(g == w, f"tail_start_index exact ({g} == {w})")
        else:
            check(resident == ndur, f"full load (resident {resident} == durable {ndur})")
        # derive agrees with the full log (compact or not)
        try:
            mf = derive_messages(full, Config(), "t")
            ml = derive_messages(log, Config(), "t")
            check(mf == ml, "derive_messages == full load")
        except Exception as e:
            check(False, f"derive_messages crashed: {e}")

    print()
    print("CONVERT VERIFY PASSED" if ok else "CONVERT VERIFY FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
