"""Tool statements: the argument -> command -> envelope translation (offline).

Run: .venv/bin/python -m tests.inst_test

Pins the conventions a tool definition relies on, all of them fail-closed:

  1. {name} is ONE shell word: shq's quoting survives the real shell, and an
     argument that looks like shell syntax stays a literal value
  2. {*} is ONE shell-quoted JSON object: the service sees the model's values
     byte-for-byte, including CJK / newlines / quotes / backslashes
  3. host vars shadow model args (a model argument can never become a port or a
     token); defaults fill what the model left out, under the model's own values
  4. [ ... ] optional groups are dropped whole (flag included) when the model
     omitted the value, and [[ / ]] are a literal bracket
  5. only `raw` names are inserted verbatim (run_command's {command})
  6. unwrap reads the module envelope, and treats an HTTP status / a non-zero
     exit as a transport failure rather than a command verdict
"""

from __future__ import annotations

import json
import shlex
import subprocess

from agent.tools.inst import InstError, jarg, render, shq, unwrap
from agent.tools.transport import CommandResult
from tests.testsupport import check, posix_shell_argv

# shell metacharacters a value must never be able to spring: quote break, command
# separator, substitution, expansion, redirect, newline, CJK, empty
HOSTILE = [
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


def _words(command: str) -> list[str]:
    """How the SHELL will see the command line (argv, quotes resolved)."""
    return shlex.split(command, posix=True)


def main() -> int:
    # 1. {name} is one quoted word — through the real shell, not just shlex
    check(shq("plain") == "'plain'", "shq wraps in single quotes")
    check(shq("it's") == "'it'\\''s'", "shq escapes an embedded single quote")
    check(shq("") == "''", "shq renders an empty value as an empty word")

    for value in HOSTILE:
        cmd = render("printf %s {v}", {"v": value})
        check(_words(cmd) == ["printf", "%s", value], f"shlex sees one word: {value!r}")
        shell = posix_shell_argv()
        if shell is None:
            continue
        # the REAL shell: printf %s <shq(value)> must reproduce the value byte for byte
        r = subprocess.run([*shell, cmd], capture_output=True, text=True, timeout=20)
        check(r.stdout == value, f"the shell reproduces the value: {value!r}")

    # 2. {*} is one quoted JSON object carrying exactly the model's values
    args = {"path": "数据.txt", "old_string": "it's \"quoted\"", "new_string": "line\nbreak", "empty": ""}
    cmd = render("curl --data-binary {*}", args)
    check(len(_words(cmd)) == 3, "{*} stays one word")
    check(json.loads(_words(cmd)[2]) == args, "{*} round-trips every value byte-for-byte, including CJK")
    check("\\u" not in _words(cmd)[2], "{*} keeps CJK unescaped (ensure_ascii=False)")

    # 3. host vars shadow model args; defaults fill the model's omissions
    cmd = render(
        "-H X-Clutch-Token:{token} --data-binary {*}",
        {"token": "model-supplied", "path": "a.txt"},
        vars={"token": "host-token", "port": "51234"},
    )
    check(_words(cmd)[1] == "X-Clutch-Token:host-token", "a host var shadows a model arg of the same name")
    payload = json.loads(_words(cmd)[-1])
    check(payload == {"token": "model-supplied", "path": "a.txt"}, "{*} still carries the model's own keys")
    cmd = render("read {max_chars} {*}", {"path": "x"}, defaults={"max_chars": 20000})
    check(_words(cmd)[1] == "20000", "a default fills an omitted argument for {name}")
    check(json.loads(_words(cmd)[2]) == {"max_chars": 20000, "path": "x"}, "defaults ride {*} under the model's values")
    cmd = render("read {max_chars}", {"max_chars": 5}, defaults={"max_chars": 20000})
    check(_words(cmd)[1] == "5", "the model's value wins over the default")

    # 4. optional groups: dropped WHOLE (flag and value) when the value is absent
    tmpl = "search {query} [--max-results {max_results}] [--backend {backend}]"
    check(
        render(tmpl, {"query": "q", "max_results": 3}) == "search 'q' --max-results '3'",
        "a filled group is kept, flag and value",
    )
    check(render(tmpl, {"query": "q"}) == "search 'q'", "an empty group drops its flag too")
    check(render(tmpl, {"query": "q", "backend": "bing"}) == "search 'q' --backend 'bing'", "groups are independent")
    check(render("[{a} {b}]", {"a": 1}) == "", "one missing placeholder drops the whole group")
    check(render("x [[not a group]] y", {}) == "x [not a group] y", "[[ / ]] are literal brackets")
    for bad in ("[{a}", "x] y", "[{a} [{b}]]"):
        try:
            render(bad, {"a": 1, "b": 2})
            check(False, f"malformed statement rejected: {bad!r}")
        except InstError:
            check(True, f"malformed statement rejected: {bad!r}")

    # 5. only `raw` names are verbatim; a model value in a non-raw slot stays quoted
    check(render("{command}", {"command": "ls | wc -l"}, raw=("command",)) == "ls | wc -l", "raw is inserted verbatim")
    check(render("{command}", {"command": "ls | wc -l"}) == "'ls | wc -l'", "the same name is quoted without raw")
    check(render("{host}", vars={"host": "127.0.0.1"}) == "'127.0.0.1'", "host vars are quoted like arguments")

    # 6. a missing value is error-as-data, never a silently mangled command
    try:
        render("read {path}", {})
        check(False, "a missing value raises InstError")
    except InstError as e:
        check("path" in str(e), "the missing-value error names the placeholder")
    for malformed in ("{}", "{1st}", "{a-b}"):
        try:
            render(malformed, {"a": 1})
            check(False, f"malformed placeholder rejected: {malformed!r}")
        except InstError:
            check(True, f"malformed placeholder rejected: {malformed!r}")
    check(render("nothing to fill", {}) == "nothing to fill", "a statement without placeholders passes through")
    check(jarg({"a": 1}) == "'{\"a\":1}'", "jarg emits one compact quoted object")

    # 7. unwrap: the module envelope is the verdict; HTTP/exit are transport facts
    ok = unwrap(CommandResult(0, json.dumps({"content": "hello", "error": False, "diff": ""}), ""))
    check(ok == {"content": "hello", "error": False, "diff": ""}, "a 200 envelope passes through unchanged")
    err_env = json.dumps({"content": "file not found: x", "error": True, "diff": "", "code": 66})
    code = unwrap(CommandResult(66, err_env, ""))
    check(code["error"] and code["content"] == "file not found: x", "an error envelope keeps the module's message")
    lazy = unwrap(CommandResult(66, json.dumps({"content": "boom", "diff": "", "code": 66}), ""))
    check(lazy["error"], "a non-zero verdict code alone still marks the result failed")
    sneaky = unwrap(CommandResult(3, json.dumps({"content": "boom", "error": False, "diff": ""}), ""))
    check(sneaky["error"], "a non-zero exit beats an optimistic envelope")
    diff_env = '{"content":"x","error":false,"diff":"d"}'
    check(unwrap(CommandResult(0, diff_env, ""))["diff"] == "d", "the diff rides through")
    plain = unwrap(CommandResult(0, "hello\n", ""))
    check(plain["content"] == "hello" and not plain.get("error"), "non-JSON stdout is the content")
    failed = unwrap(CommandResult(2, "", "ls: nope: No such file"))
    check(
        failed["error"] and "exit 2" in failed["content"] and "no such file" in failed["content"].lower(),
        "a failed command reports exit + stderr",
    )
    check(unwrap(CommandResult(0, "", ""))["content"].startswith("OK:"), "empty success output is still an OK")

    # 7b. curl's -w status line: transport statuses are NOT command verdicts
    body, status = '{"content":"bad or missing token","error":true}', "403"
    r = unwrap(CommandResult(0, f"{body}\n{status}", ""))
    check(r["error"] and "HTTP 403" in r["content"], "a non-200 status is reported as the service's answer")
    r = unwrap(CommandResult(7, "\n000", "curl: (7) Failed to connect"))
    check(r["error"] and "could not reach" in r["content"], "status 000 (nothing listening) reads as unreachable")
    r = unwrap(CommandResult(0, '{"content":"ok","error":false,"diff":""}\n200', ""))
    check(r["content"] == "ok" and not r["error"], "the 200 status line is stripped from a good body")
    unreachable = unwrap(CommandResult(1, "", ""), service="the workspace service")
    check(
        unreachable["content"].startswith("ERROR: the workspace service failed"),
        "the service name lands in the error text",
    )

    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
