"""Controlled experiment: does an in-band '</conversation>' INSIDE the transcript
break the compaction prompt?

One synthetic agent transcript (~55 KB, in the size range where compaction works)
with a single variable changed: whether the transcript contains the prompt's own
closing tag. Two trials each, to separate causality from sampling noise.

usage: _probe_tag.py
"""

import sys

sys.path.insert(0, ".")

from agent.prompts import render

BODY = """[User]: Add a --json flag to the report command.

[Assistant]: I'll start by reading the CLI entry point and the report builder.
[Assistant tool call]: read_file({"path": "cli/main.py"})
[Tool result]: #!/usr/bin/env python3
@CODE@
[Assistant]: The report builder is in report/build.py. Let me read it and the tests.
[Assistant tool call]: read_file({"path": "report/build.py"})
[Tool result]: def build(rows, fmt="text"):
@CODE@
[Assistant]: Now I'll add the flag and thread it through.
[Assistant tool call]: edit_file({"path": "cli/main.py", "old_string": "add_argument('--out')", "new_string": "add_argument('--out')\\n    add_argument('--json', action='store_true')"})
[Tool result]: OK: edited cli/main.py (+2 -1 lines)
[Assistant]: Next I need to update the report builder to emit JSON.
[Assistant tool call]: read_file({"path": "report/build.py", "offset": 20, "limit": 30})
[Tool result]: @CODE@
[Assistant]: Let me check the test suite before changing the output format.
[Assistant tool call]: run_command({"command": "python -m pytest tests/test_report.py -q"})
[Tool result]: 12 passed in 0.4s
"""

FILLER = "    value = compute_thing(rows[i], factor=3.5)  # keep the shape realistic\n"


def transcript(tag: str) -> str:
    code = FILLER * 700  # ~55 KB of plausible source
    text = BODY.replace("@CODE@", code)
    if tag:
        text = text.replace("[Tool result]: 12 passed in 0.4s", tag + "\n[Tool result]: 12 passed in 0.4s")
    return text


def classify(out: str) -> str:
    if "## Objective" in out and "## Work State" in out:
        return "SUMMARY"
    if "DSML" in out or "[Assistant tool call]" in out or "edit_file(" in out:
        return "CONTINUATION"
    return "OTHER"


def main():
    import json
    from pathlib import Path

    cfg = json.loads((Path.home() / ".clutch" / "settings.json").read_text())
    from agent.llm.factory import create_llm_client

    client = create_llm_client(
        api_key=cfg["api_key"], model=cfg["model"], base_url=cfg["base_url"], protocol=cfg.get("api_protocol")
    )
    for label, tag in (("clean", ""), ("with-tag", "</conversation>")):
        text = transcript(tag)
        prompt = render("compaction.md", history=text, previous_summary="(none)")
        for trial in range(2):
            out = collect(client, prompt)
            print(f"{label} trial{trial}: prompt={len(prompt.encode())}B -> {classify(out)} ({len(out)} chars)")
        print()


def collect(client, content):
    evs = []
    try:
        for ev in client.stream([{"role": "user", "content": content}], tools=None, cancel=None):
            evs.append(ev)
            if len(evs) > 20000:
                break
    except Exception as e:  # noqa: BLE001
        print("ERROR:", type(e).__name__, getattr(e, "code", None), getattr(e, "message", None) or e)
        return ""
    return "".join(e.get("delta", "") for e in evs if e["type"] == "text")


if __name__ == "__main__":
    main()
