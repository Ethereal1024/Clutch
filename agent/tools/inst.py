"""Declarative tool statements: one Tool = one terminal command.

A tool definition is pure data — name / description / parameters / inst. `inst`
is the shell command line that satisfies a call, with {placeholders} filled from
the model's arguments. This module owns that ONE translation (arguments ->
command text) and the ONE translation back (command output -> the
{content, error, diff} envelope the loop consumes), so every tool request is a
terminal command and the transport decides where it runs.

Placeholders, fail-closed by design:

    {name}   one MODEL argument, POSIX-shell-quoted as a single word
    {*}      ALL model arguments as one shell-quoted JSON object (jarg)
    {name}   a HOST value (a service's port/token, a resolved path) when the
             name is among `vars`: host vars shadow model args of the same
             name, so a model argument can never hijack a host placeholder
    [ ... ]  optional group: dropped whole — brackets, flag and value — when one
             of the placeholders inside has no value (a CLI flag the model did
             not ask for). `[[` / `]]` are a literal bracket.

Quoting is the default, because a command line is a shell's INPUT, not string
concatenation: `{query}` renders `shq(query)`, so a value like `; rm -rf /` stays
one literal word instead of becoming a second command. The only verbatim
insertion is a caller-listed `raw` name — run_command's {command}, whose text IS
a shell command; its safety boundary is the host's permission engine
(tools/shell.py), never the renderer.

Output contract: `unwrap` turns a finished command into {content, error, diff}.
A stdout JSON object carrying "content" IS the envelope (it is what the
standalone modules print — the workspace daemon's verdict-rides-200 bodies, the
CLIs' --json output); anything else is framed by exit code, exactly the way the
run_command engine has always framed it. HTTP statuses, when the command reports
one (curl's `-w '%{http_code}'`), are transport failures — they mean no service
spoke our protocol, which is a different thing from a command's own verdict.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

from .transport import CommandResult
from .workspace import shq

__all__ = ["InstError", "jarg", "render", "unwrap", "shq"]

_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*|\*)\}")
_UNREACHABLE = "ERROR: could not reach {service}: {detail}"


class InstError(Exception):
    """The statement cannot be rendered for these arguments (a spec/args
    mismatch — reported to the model as error-as-data, never as a crash)."""


def jarg(obj: Any) -> str:
    """One shell-quoted JSON object: the request body of an HTTP/CLI service.

    Exactly ONE escaping pass per layer (json for the body, shq for the shell),
    so the service sees the model's argument values byte-for-byte — never a
    JSON string that was quoted twice and arrives with the escapes still in it.
    """
    return shq(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def _tokens(template: str) -> list[tuple[str, str | None]]:
    """Split a statement into ("text", s) / ("ph", name) / ("open", None) /
    ("close", None). Raises InstError on a malformed placeholder."""
    out: list[tuple[str, str | None]] = []
    i, n = 0, len(template)
    while i < n:
        ch = template[i]
        if ch == "{":
            m = _PLACEHOLDER.match(template, i)
            if m is None:
                raise InstError(f"bad placeholder in tool statement: {template[i:i + 40]!r}")
            out.append(("ph", m.group(1)))
            i = m.end()
        elif ch == "[":
            if template.startswith("[[", i):
                out.append(("text", "["))
                i += 2
            else:
                out.append(("open", None))
                i += 1
        elif ch == "]":
            if template.startswith("]]", i):
                out.append(("text", "]"))
                i += 2
            else:
                out.append(("close", None))
                i += 1
        else:
            stops = [k for k in (template.find("{", i), template.find("[", i), template.find("]", i)) if k != -1]
            j = min(stops) if stops else n
            out.append(("text", template[i:j]))
            i = j
    return out


def render(
    template: str,
    args: Mapping[str, Any] | None = None,
    *,
    vars: Mapping[str, Any] | None = None,
    defaults: Mapping[str, Any] | None = None,
    raw: tuple[str, ...] = (),
) -> str:
    """The command line for one tool call.

    `args` are the model's arguments (quoted), `vars` the host's resolved values
    (quoted, shadowing `args`), `defaults` the host's per-tool payload defaults
    (merged UNDER the model's arguments — an argument the model left out gets
    the host's default instead of a hole in the request), `raw` the placeholder
    names inserted verbatim.
    """
    model = dict(args or {})
    host = {k: str(v) for k, v in (vars or {}).items()}
    merged = {**(defaults or {}), **model}
    raws = set(raw)

    def value(name: str) -> str | None:
        """The rendered word for a placeholder, or None when nobody provided it."""
        if name == "*":
            return jarg(merged)
        if name in host:
            return host[name] if name in raws else shq(host[name])
        if name in merged:
            text = str(merged[name])
            return text if name in raws else shq(text)
        return None

    tokens = _tokens(template)
    # which tokens an optional group drops: a group whose placeholders cannot all
    # be filled is dropped whole, flag included — a half-filled flag is worse
    drop = [False] * len(tokens)
    dropped: list[tuple[int, int]] = []
    open_at: list[tuple[int, bool]] = []
    for idx, (kind, name) in enumerate(tokens):
        if kind == "open":
            if open_at:
                raise InstError("nested optional groups are not supported in a tool statement")
            open_at.append((idx, False))
        elif kind == "close":
            if not open_at:
                raise InstError(f"unmatched ']' in tool statement: {template!r}")
            start, missing = open_at.pop()
            if missing:
                dropped.append((start, idx))
                for k in range(start, idx + 1):
                    drop[k] = True
        elif kind == "ph" and value(name) is None:
            if open_at:
                open_at[-1] = (open_at[-1][0], True)
            else:
                raise InstError(f"missing value for {{{name}}} (tool arguments: {sorted(model)})")
    if open_at:
        raise InstError(f"unclosed '[' in tool statement: {template!r}")
    # a dropped group takes the whitespace that separated it from the word before
    # it: `cmd a [--flag {x}]` must come out as `cmd a`, not `cmd a `
    texts = {(idx, "text"): (text or "") for idx, (kind, text) in enumerate(tokens) if kind == "text"}
    for start, _ in dropped:
        prev = texts.get((start - 1, "text"))
        if prev is not None and prev != prev.rstrip():
            texts[(start - 1, "text")] = prev.rstrip()

    parts: list[str] = []
    for idx, (kind, text) in enumerate(tokens):
        if drop[idx] or kind in ("open", "close"):
            continue
        parts.append((value(text) or "") if kind == "ph" else texts[(idx, "text")])
    return "".join(parts)


def _envelope(text: str) -> dict[str, Any] | None:
    """The {content, error, diff} object a service printed, or None when the
    output is not one (a plain command's stdout, a crash, empty output)."""
    try:
        obj = json.loads(text.strip() or "null")
    except ValueError:
        return None
    if isinstance(obj, dict) and isinstance(obj.get("content"), str):
        return obj
    return None


def _body_and_status(stdout: str) -> tuple[str, int | None]:
    """Split a body from the HTTP status a command appended (curl's
    `-w '\\n%{http_code}'` shape: the last line is the status)."""
    body, _, last = stdout.rstrip("\n").rpartition("\n")
    if last.isdigit() and len(last) == 3:
        return body, int(last)
    return stdout, None


def unwrap(result: CommandResult, *, service: str = "the tool service") -> dict[str, Any]:
    """The loop's envelope for a finished command (see the module docstring)."""
    body, status = _body_and_status(result.stdout)
    env = _envelope(body)
    if status is not None and status != 200:
        detail = body.strip()[:500] or (result.stderr or "").strip()[:500]
        if status == 0:  # curl never got a reply: nothing is listening
            return {"content": _UNREACHABLE.format(service=service, detail=detail or "no reply"), "error": True}
        return {"content": f"ERROR: {service} answered HTTP {status}: {detail}", "error": True}
    if env is not None:
        # "code" is the transports' verdict (sysexits); error/diff are the
        # module envelope's own fields. Either one saying "failed" is enough —
        # and so is a non-zero exit, so a service bug cannot hide behind an
        # optimistic envelope.
        failed = bool(env.get("error")) or bool(env.get("code")) or result.code != 0
        return {
            "content": str(env.get("content", "")),
            "error": failed,
            "diff": str(env.get("diff") or ""),
        }
    out = result.stdout.strip()
    if result.code != 0:
        tail = (result.stderr or "").strip() or out
        msg = f"ERROR: {service} failed (exit {result.code})"
        return {"content": f"{msg}: {tail[-500:]}" if tail else msg, "error": True}
    return {"content": out or f"OK: {service} succeeded, no output."}
