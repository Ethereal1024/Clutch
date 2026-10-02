"""Find diff-shaped tool results (write_file/edit_file) that carry no diff and
are errors, in the logs sitting in the repo root.

Those are exactly the events the UI renders as a "result ⚠" block with nothing
under it: the declaration's body is the diff, the envelope's diff is "" on
every error, and the message lives in `content`.
"""

import glob
import json


def main() -> None:
    total = 0
    diffable = 0
    for f in sorted(glob.glob("*.clc")):
        calls = {}
        for line in open(f, encoding="utf-8", errors="replace"):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            t = ev.get("type")
            if t == "tool_call":
                calls[ev.get("tool_call_id")] = ev.get("name")
            elif t == "tool_result":
                total += 1
                cid = ev.get("tool_call_id")
                nm = calls.get(cid)
                if nm not in ("write_file", "edit_file"):
                    continue
                if ev.get("diff"):
                    continue
                diffable += 1
                print(f"{f} {nm} {cid} err={ev.get('is_error')} content={ev.get('content')!r:.120}")
    print(f"\ntool_results={total} diff-shaped-without-diff={diffable}")


if __name__ == "__main__":
    main()
