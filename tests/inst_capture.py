"""Golden capture for the statement renderer (M3: `ui/host/inst.js`).

A component's tool is one terminal command: `{placeholders}` filled from the
model's arguments and the host's own facts, run, and turned back into the
envelope the loop consumes. `agent/tools/inst.py` owns that ONE translation in
both directions, and `tests/host-inst.test.js` replays it against
`ui/host/inst.js`.

    .venv/bin/python -m tests.inst_capture            # write the fixture
    .venv/bin/python -m tests.inst_capture --check    # regenerate+compare

Everything here is pure: no workspace, no process, no clock. What it pins is the
contract three other modules already rely on —

  * quoting (`{name}` is ONE shell word; `shq` is the only escaper),
  * `{*}` as one shell-quoted JSON object with SORTED keys (the payload's byte
    order is the host's, not the declaration file's),
  * host vars shadowing model args, defaults filling what the model omitted,
  * `[ ... ]` optional groups dropped WHOLE (flag included) and `[[`/`]]` literal,
  * `raw` names inserted verbatim (run_command's `{command}`) and nothing else,
  * fail-closed errors as error-as-data (the sentence the model reads),
  * `unwrap`: a stdout JSON object carrying `content` IS the envelope, anything
    else is framed by the exit code — and nothing parses a status line out of it.

The values that go through the quoting cases are the hostile ones (quote breaks,
`$(id)`, backticks, `${HOME}`, newlines, CJK, empty): the fixture records the
rendered line, and `tests/host-inst.test.js` additionally runs it through the
real `/bin/sh` so "one word" is proved by a shell and not by a parser.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent.tools.envelope import Envelope
from agent.tools.inst import InstError, jarg, render, shq, unwrap
from agent.tools.transport import CommandResult

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures" / "inst" / "expected.json"

HOSTILE = [
    "plain",
    "it's",
    "'; rm -rf /; echo '",
    "$(id)",
    "`id`",
    "${HOME}",
    "a'; cat /etc/passwd; echo '",
    "line1\nline2",
    'quote " and \\ backslash',
    "中文 参数，带标点。",
    "",
]

# (name, template, args, vars, defaults, raw) — the expected text is what the
# REAL renderer returns; an exception is recorded as {"error": str(e)}.
RENDER_CASES = [
    ("no placeholders", "nothing to fill", {}, {}, {}, ()),
    ("empty template", "", {}, {}, {}, ()),
    ("one word", "printf %s {v}", {"v": "plain"}, {}, {}, ()),
]
RENDER_CASES += [(f"hostile {value!r}", "printf %s {v}", {"v": value}, {}, {}, ()) for value in HOSTILE]
RENDER_CASES += [
    # -- {*} : one shell-quoted JSON object ---------------------------------
    ("payload", "curl --data-binary {*}", {"path": "数据.txt", "old_string": "it's \"quoted\""}, {}, {}, ()),
    ("payload newline", "read {*}", {"new_string": "line\nbreak", "empty": ""}, {}, {}, ()),
    ("payload nested", "read {*}", {"opts": {"b": 2, "a": [1, True, None]}, "path": "x"}, {}, {}, ()),
    ("payload sorted keys", "read {*}", {"z": 1, "a": 2, "m": 3}, {}, {}, ()),
    ("payload from defaults", "read {*}", {"path": "x"}, {}, {"max_chars": 20000, "path": "ignored"}, ()),
    # -- host vars / defaults ----------------------------------------------
    ("host var shadows", "-H X-Clutch-Token:{token} --data-binary {*}",
     {"token": "model-supplied", "path": "a.txt"}, {"token": "host-token", "port": "51234"}, {}, ()),
    ("host var quoting", "{host}", {}, {"host": "127.0.0.1"}, {}, ()),
    ("host var raw", "{host}", {}, {"host": "a b"}, {}, ("host",)),
    ("default fills", "read {max_chars} {*}", {"path": "x"}, {}, {"max_chars": 20000}, ()),
    ("model beats default", "read {max_chars}", {"max_chars": 5}, {}, {"max_chars": 20000}, ()),
    ("default under raw", "{m}", {"m": "x"}, {}, {"m": "ignored"}, ("m",)),
    # -- optional groups ----------------------------------------------------
    ("group kept", "search {query} [--max-results {max_results}] [--backend {backend}]",
     {"query": "q", "max_results": 3}, {}, {}, ()),
    ("group dropped", "search {query} [--max-results {max_results}] [--backend {backend}]",
     {"query": "q"}, {}, {}, ()),
    ("groups independent", "search {query} [--max-results {max_results}] [--backend {backend}]",
     {"query": "q", "backend": "bing"}, {}, {}, ()),
    ("group drops whole", "[{a} {b}]", {"a": 1}, {}, {}, ()),
    ("group after placeholder", "cmd {a}[--x {b}]", {"a": 1}, {}, {}, ()),
    ("group needs a host value", "curl -H X:{token} [--data {body}]", {}, {"token": "t"}, {}, ()),
    ("literal brackets", "x [[not a group]] y", {}, {}, {}, ()),
    ("literal close", "x ]] y", {}, {}, {}, ()),
    ("group with tab separator", "cmd a\t[--flag {x}]", {}, {}, {}, ()),
    ("two groups, one filled", "[--a {a}] [--b {b}]", {"b": 2}, {}, {}, ()),
    ("empty arg value fills", "read [--max {n}]", {"n": ""}, {}, {}, ()),
    # -- raw ----------------------------------------------------------------
    ("raw verbatim", "{command}", {"command": "ls | wc -l"}, {}, {}, ("command",)),
    ("raw but unlisted", "{command}", {"command": "ls | wc -l"}, {}, {}, ()),
    # -- values that are not strings ---------------------------------------
    ("boolean value", "{flag}", {"flag": True}, {}, {}, ()),
    ("number value", "{n}", {"n": 2.5}, {}, {}, ()),
    ("null value", "{v}", {"v": None}, {}, {}, ()),
    ("list value", "{v}", {"v": ["a", 1, False]}, {}, {}, ()),
    ("dict value", "{v}", {"v": {"b": 1, "a": "x"}}, {}, {}, ()),
    # -- errors (error-as-data) ---------------------------------------------
    ("missing value", "read {path}", {}, {}, {}, ()),
    ("missing value names sorted args", "read {path}", {"zeta": 1, "alpha": 2}, {}, {}, ()),
    ("nested groups", "[{a} [{b}]]", {"a": 1, "b": 2}, {}, {}, ()),
    ("unmatched close", "x] y", {}, {}, {}, ()),
    ("unclosed group", "[{a}", {"a": 1}, {}, {}, ()),
    ("empty braces", "{}", {"a": 1}, {}, {}, ()),
    ("digit name", "{1st}", {"a": 1}, {}, {}, ()),
    ("dash name", "{a-b}", {"a": 1}, {}, {}, ()),
    ("lone brace", "{", {}, {}, {}, ()),
    ("brace then name", "{a{", {"a": 1}, {}, {}, ()),
    ("star inside name", "{a*}", {"a": 1}, {}, {}, ()),
]

# `unwrap(CommandResult(code, stdout, stderr), service=...)`
UNWRAP_CASES = [
    ("envelope passes through", 0, json.dumps({"content": "hello", "error": False, "diff": ""}), "", None),
    ("error envelope", 66, json.dumps({"content": "file not found: x", "error": True, "diff": "", "code": 66}), "", None),
    ("code alone fails", 66, json.dumps({"content": "boom", "diff": "", "code": 66}), "", None),
    ("non-zero exit beats an optimistic envelope", 3,
     json.dumps({"content": "boom", "error": False, "diff": ""}), "", None),
    ("diff rides through", 0, '{"content":"x","error":false,"diff":"d"}', "", None),
    ("string code is truthy", 0, '{"content":"x","code":"0"}', "", None),
    ("zero code is falsy", 0, '{"content":"x","code":0}', "", None),
    ("non-string content is not an envelope", 0, '{"content":5}', "", None),
    ("array is not an envelope", 0, '["content"]', "", None),
    ("null output", 0, "null", "", None),
    ("plain stdout", 0, "hello\n", "", None),
    ("padded plain stdout", 0, "  hello  \n\n", "", None),
    ("empty success", 0, "", "", None),
    ("whitespace-only success", 0, " \n\t ", "", None),
    ("failed command with stderr", 2, "", "ls: nope: No such file", None),
    ("failed command with stdout only", 2, "the output\n", "", None),
    ("failed and silent", 1, "", "", None),
    ("named service", 7, "", "curl: (7) Failed to connect", "the workspace service"),
    ("long stderr is clipped", 2, "", "x" * 600, None),
    ("envelope beats stderr", 0, '{"content":"x","error":true,"diff":""}', "ignored", None),
    ("trailing status line", 0,
     '{"content":"bad or missing token","error":true,"diff":""}\n403', "", None),
    ("broken json", 0, '{"content": ', "", None),
    ("diff is not a string", 0, '{"content":"x","diff":5}', "", None),
]

JARG_CASES = [
    {"a": 1},
    {"b": 1, "a": 2},
    {"path": "数据.txt"},
    {"text": "it's"},
    {},
    {"nested": {"b": [1, 2], "a": None}},
]

SHQ_CASES = ["plain", "it's", "", "a b", "$(id)", "中文"]


def capture() -> dict:
    renders = []
    for name, template, args, vars_, defaults, raw in RENDER_CASES:
        record = {
            "name": name,
            "template": template,
            "args": args,
            "vars": vars_,
            "defaults": defaults,
            "raw": list(raw),
        }
        try:
            record["line"] = render(template, args, vars=vars_, defaults=defaults, raw=raw)
        except InstError as e:
            record["error"] = str(e)
        renders.append(record)

    unwraps = []
    for name, code, stdout, stderr, service in UNWRAP_CASES:
        result = CommandResult(code, stdout, stderr)
        env = unwrap(result) if service is None else unwrap(result, service=service)
        unwraps.append({
            "name": name,
            "code": code,
            "stdout": stdout,
            "stderr": stderr,
            "service": service,
            "expect": {"content": env.content, "error": env.error, "diff": env.diff},
        })

    return {
        "render": renders,
        "jarg": [{"value": value, "text": jarg(value)} for value in JARG_CASES],
        "shq": [{"value": value, "text": shq(value)} for value in SHQ_CASES],
        "unwrap": unwraps,
    }


def verify(fixture: dict) -> int:
    expected = json.loads(OUT.read_text("utf-8"))
    if expected != fixture:
        print("statements goldens DO NOT reproduce:")
        for key in fixture:
            if expected.get(key) != fixture[key]:
                print(f"  {key}: differs")
                for want, have in zip(expected.get(key) or [], fixture[key]):
                    if want != have:
                        print(f"    {json.dumps(want, ensure_ascii=False)}")
                        print(f"    {json.dumps(have, ensure_ascii=False)}")
                        break
        return 1
    print(f"statement goldens reproduce: {len(fixture['render'])} renders, "
          f"{len(fixture['unwrap'])} unwraps, {len(fixture['jarg'])} payloads")
    return 0


def main(argv: list[str]) -> int:
    fixture = capture()
    if "--check" in argv:
        return verify(fixture)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(f"wrote {OUT.relative_to(HERE.parent)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(__import__("sys").argv[1:]))
