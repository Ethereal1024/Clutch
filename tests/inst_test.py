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
  6. unwrap reads the module envelope: a service speaks its verdict in the
     envelope (transport trouble included) and nothing is parsed out of the
     output — the exit code is the only other input
"""

from __future__ import annotations

import json
import subprocess

from agent.tools.inst import InstError, jarg, render, shq, unwrap
from agent.tools.transport import CommandResult
from tests.testsupport import check, posix_shell_argv, shell_words

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


def main() -> int:
    # 1. {name} is one quoted word — through the real shell, not just shlex
    check(shq("plain") == "'plain'", "shq wraps in single quotes")
    check(shq("it's") == "'it'\\''s'", "shq escapes an embedded single quote")
    check(shq("") == "''", "shq renders an empty value as an empty word")

    for value in HOSTILE:
        cmd = render("printf %s {v}", {"v": value})
        check(shell_words(cmd) == ["printf", "%s", value], f"shlex sees one word: {value!r}")
        shell = posix_shell_argv()
        if shell is None:
            continue
        # the REAL shell: printf %s <shq(value)> must reproduce the value byte for byte
        r = subprocess.run([*shell, cmd], capture_output=True, text=True, timeout=20)
        check(r.stdout == value, f"the shell reproduces the value: {value!r}")

    # 2. {*} is one quoted JSON object carrying exactly the model's values
    args = {"path": "数据.txt", "old_string": "it's \"quoted\"", "new_string": "line\nbreak", "empty": ""}
    cmd = render("curl --data-binary {*}", args)
    check(len(shell_words(cmd)) == 3, "{*} stays one word")
    check(json.loads(shell_words(cmd)[2]) == args, "{*} round-trips every value byte-for-byte, including CJK")
    check("\\u" not in shell_words(cmd)[2], "{*} keeps CJK unescaped (ensure_ascii=False)")

    # 3. host vars shadow model args; defaults fill the model's omissions
    cmd = render(
        "-H X-Clutch-Token:{token} --data-binary {*}",
        {"token": "model-supplied", "path": "a.txt"},
        vars={"token": "host-token", "port": "51234"},
    )
    check(shell_words(cmd)[1] == "X-Clutch-Token:host-token", "a host var shadows a model arg of the same name")
    payload = json.loads(shell_words(cmd)[-1])
    check(payload == {"token": "model-supplied", "path": "a.txt"}, "{*} still carries the model's own keys")
    cmd = render("read {max_chars} {*}", {"path": "x"}, defaults={"max_chars": 20000})
    check(shell_words(cmd)[1] == "20000", "a default fills an omitted argument for {name}")
    check(
        json.loads(shell_words(cmd)[2]) == {"max_chars": 20000, "path": "x"},
        "defaults ride {*} under the model's values",
    )
    cmd = render("read {max_chars}", {"max_chars": 5}, defaults={"max_chars": 20000})
    check(shell_words(cmd)[1] == "5", "the model's value wins over the default")

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

    # 7. unwrap: the module envelope is the verdict; the exit code is the only
    #    other input (a status line is not understood — see 7b)
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

    # 7b. the envelope is the ONLY thing read: a service says "no service spoke
    #     our protocol" in that same envelope (the daemon's transport errors are
    #     envelopes), and a status line appended by a statement's own syntax
    #     (curl's `-w '%{http_code}'`) is just text the host passes through —
    #     parsing it would make one client's convention the host's vocabulary
    refusal = '{"content":"bad or missing token","error":true,"diff":""}'
    r = unwrap(CommandResult(0, refusal, ""))
    check(r["error"] and r["content"] == "bad or missing token", "a 403 body IS the envelope (no status needed)")
    r = unwrap(CommandResult(0, f"{refusal}\n403", ""))
    # `error` is read with .get here on purpose: an envelope that does not
    # parse is PLAIN TEXT, and this branch of unwrap carries no `error`/`diff`
    # key at all — the single-envelope type is P1-4, still open. What this
    # asserts is only that nothing parses the trailing `403` as a status.
    check(
        not r.get("error") and r["content"].endswith("403"),
        "a trailing status line makes unparseable text, not a parsed status (fail visible, not clever)",
    )
    r = unwrap(CommandResult(7, "", "curl: (7) Failed to connect"), service="the workspace service")
    check(
        r["error"] and r["content"].startswith("ERROR: the workspace service failed (exit 7)"),
        "a dead service is the exit code plus curl's own words, never a host-side guess",
    )
    unreachable = unwrap(CommandResult(1, "", ""), service="the workspace service")
    check(
        unreachable["content"].startswith("ERROR: the workspace service failed"),
        "the service name lands in the error text",
    )

    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
