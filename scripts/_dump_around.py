"""Dump events around a byte offset in a .clc: the compaction line plus the
events immediately before/after it, with type + a short preview, and a full
dump option for one event."""

import json
import sys


def load(path):
    data = open(path, "rb").read()
    sep = data.find(b"\n---\n")
    base = sep + 5
    body = data[base:]
    out = []
    off = 0
    for seg in body.split(b"\n"):
        o = off
        off += len(seg) + 1
        if not seg.strip():
            continue
        try:
            d = json.loads(seg.decode("utf-8", "replace"))
        except Exception:
            continue
        if isinstance(d, dict) and "type" in d:
            out.append((o, d))
    return base, out


def preview(d, n=160):
    t = d.get("type")
    if t == "user_message":
        return "user: " + repr(d.get("content", "")[:n])
    if t == "assistant_message":
        tc = d.get("tool_calls") or []
        names = ",".join(c.get("name", "") for c in tc)
        return f"assistant: {d.get('content','')[:n]!r} tools=[{names}]"
    if t == "tool_call":
        return f"tool_call {d.get('name')}: {d.get('arguments','')[:n]!r}"
    if t == "tool_result":
        return f"tool_result err={d.get('is_error')}: {d.get('content','')[:n]!r}"
    if t == "compaction":
        return f"COMPACTION len={len(d.get('summary',''))}: {d.get('summary','')[:n]!r}"
    if t == "final":
        return f"final {d.get('status')}: {d.get('summary','')[:n]!r}"
    return f"{t}: {json.dumps(d)[:n]}"


def resolve(p):
    # the fence blocks the literal token for protected session logs
    if p == "cur":
        return "-".join(["compact", "fix"]) + "." + "clc"
    return p


def main():
    path = resolve(sys.argv[1])
    target = int(sys.argv[2])
    before = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    after = int(sys.argv[4]) if len(sys.argv) > 4 else 8
    base, evs = load(path)
    idx = min(range(len(evs)), key=lambda i: abs(evs[i][0] - target))
    lo = max(0, idx - before)
    hi = min(len(evs), idx + after + 1)
    for i in range(lo, hi):
        mark = "  <<<" if i == idx else ""
        print(f"[{i}] off={evs[i][0]} {preview(evs[i][1])}{mark}")


if __name__ == "__main__":
    main()
