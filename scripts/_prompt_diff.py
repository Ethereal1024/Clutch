"""Diff the production prompt (prompts.render -> Template.safe_substitute) against
the naive .replace() build, to see exactly how they differ.

usage: _prompt_diff.py <file> <k>
"""

import sys

sys.path.insert(0, ".")

from _probe_struct import build  # noqa: E402

from agent.prompts import load, render  # noqa: E402


def main():
    path, k = sys.argv[1], int(sys.argv[2])
    text, prev = build(path, k)
    a = render("compaction.md", history=text, previous_summary=prev or "(none)")
    b = load("compaction.md").replace("$history", text).replace("$previous_summary", prev or "(none)")
    print(f"render={len(a.encode())}B  replace={len(b.encode())}B  delta={len(b.encode()) - len(a.encode())}")
    print(f"transcript has '$history': {text.count('$history')}  '$previous_summary': {text.count('$previous_summary')}")
    if a == b:
        print("IDENTICAL")
        return
    p = 0
    while p < min(len(a), len(b)) and a[p] == b[p]:
        p += 1
    s = 0
    while s < min(len(a), len(b)) - p and a[len(a) - 1 - s] == b[len(b) - 1 - s]:
        s += 1
    print(f"common prefix {p}, common suffix {s}")
    print(f"\n--- A (len {len(a)}) differs from B (len {len(b)}) between prefix and suffix")
    print("  A:", repr(a[max(0, p - 120):len(a) - s])[:600])
    print("\n  B:", repr(b[max(0, p - 120):len(b) - s])[:600])
    print("\n  literal '$previous_summary' at:", [m for m in range(len(a)) if a.startswith("$previous_summary", m)])
    print("  literal '$history' count in A:", a.count("$history"))


if __name__ == "__main__":
    main()
