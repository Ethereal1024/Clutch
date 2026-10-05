"""Permission engine: decide whether a tool call may proceed.

Adapted from opencode's permission model (ruleset of allow/ask/deny, find-last
match, default allow inside the workspace). The safety model is "confirm, don't
hide": the agent works in the user's directory, and risky actions prompt the user
instead of being sandboxed away.

Decision flow for one tool call:
  evaluate(args, workspace, access) -> Action
    allow  -> execute
    ask    -> publish a permission request, block until the user replies
    deny   -> feed an error back to the model

Rules are evaluated in order; the LAST matching rule wins (opencode findLast).
A rule matches the access a tool's DECLARATION names (GUARDED_ARG) — never the
tool's name, so a component's tools enter this policy the moment they are
declared. The default action is allow for anything inside the workspace.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..tools import catalog
from ..tools.localshell import split_command
from ..tools.workspace import Workspace

Action = str  # "allow" | "ask" | "deny"

# The host POLICY a declaration may put a tool under (catalog.Tool.access) and the
# argument that policy judges BY DEFAULT. The vocabulary is the declaration
# protocol's (catalog.ACCESS_ARGS) — this engine does not keep a second copy of
# it; it reads which argument to judge from the tool's own declaration
# (registry.access_arg), falling back to the word's default here. Note what is
# NOT here — a tool NAME. What a call is allowed to touch is the declaration's
# business, so installing a component adds its tools to this policy without
# touching this file.
GUARDED_ARG: dict[str, str] = dict(catalog.ACCESS_ARGS)


@dataclass
class Rule:
    action: Action
    access: str = "*"  # the access the tool DECLARED, or "*" for any
    pattern: str = ""  # regex on the guarded argument; empty = match any
    # True = only fires when the guarded paths really leave the workspace
    escape: bool = False

    def matches(self, guarded: Any, access: str) -> bool:
        if self.access != "*" and self.access != access:
            return False
        if not self.pattern:
            return True
        text = guarded if isinstance(guarded, str) else json.dumps(guarded)
        try:
            return re.search(self.pattern, text, re.IGNORECASE) is not None
        except re.error:
            return False


# Ask for user confirmation; the caller must resolve it (see PermissionGate).
class PermissionRequired(Exception):
    def __init__(self, request_id: str, tool: str, args_repr: str, reason: str) -> None:
        super().__init__(reason)
        self.request_id = request_id
        self.tool = tool
        self.args_repr = args_repr
        self.reason = reason


DEFAULT_RULES: list[Rule] = [
    # danger: destructive/irreversible commands always ask
    Rule("ask", "command", r"\brm\s+-rf\b|\bsudo\b|\bshutdown\b|\breboot\b|\bmkfs\b|\bdd\b\s"),
    # commands that delete anything ask
    Rule("ask", "command", r"^\s*rm\b"),
    # running outside the workspace asks — only when it really escapes (an
    # absolute path INSIDE the root is not an escape)
    Rule("ask", "command", r"\bmv\s+.*\s/\s", escape=True),
    Rule("ask", "command", r"(\.\./|^/)", escape=True),
    # and so does a write that names a path outside it
    Rule("ask", "write", r"(\.\./|^/|~)", escape=True),
]


@dataclass
class PermissionEvaluator:
    rules: list[Rule] = field(default_factory=lambda: list(DEFAULT_RULES))

    def evaluate(self, args_repr: str, workspace: Workspace, access: str, arg: str = "") -> Action:
        # Judge the guarded argument (the command, the path) rather than the whole
        # JSON: content is data, not a path, and must never prompt a write it does
        # not touch. WHICH argument that is comes from the tool's own declaration
        # (registry.access_arg, falling back to the vocabulary's default), never
        # from its name.
        key = arg or GUARDED_ARG.get(access)
        guarded: Any = args_repr
        if key:
            value = _parse_args(args_repr).get(key)
            if value is not None:
                guarded = value
        # last matching rule wins
        decision: Rule | None = None
        for rule in self.rules:
            if rule.matches(guarded, access):
                decision = rule
        if decision is not None:
            # escape rule: allow when no referenced path really leaves the workspace
            if decision.escape and not self.escaped_paths(args_repr, workspace, access, arg):
                return "allow"
            return decision.action
        return "allow"

    def escaped_paths(self, args_repr: str, workspace: Workspace, access: str, arg: str = "") -> frozenset[Path]:
        """Resolved absolute paths outside the workspace root this call references;
        empty means the call stays in the sandbox.

        ``access`` decides how to read the payload: a "command" names its paths in
        shell text, every other guarded access names one in the argument its
        declaration points at (``arg``; the word's default when the declaration
        says nothing). A tool the declaration leaves unguarded references nothing
        this can judge."""
        if access not in GUARDED_ARG:
            return frozenset()
        args = _parse_args(args_repr)
        if access == "command":
            # tokenize in the flavor of the shell that will RUN the text:
            # cmd's lexer keeps backslashes literal, so shlex would corrupt
            # C:\ paths on a cmd-flavored host; a remote (SSH) workspace is
            # always POSIX no matter what the app host is
            tokens = split_command(
                (args.get("command") or "").strip(), workspace.exec_shell().posix
            )
            if tokens is None:
                return frozenset()
        else:
            path = args.get(arg or GUARDED_ARG.get(access, ""))
            if path is None:
                return frozenset()
            tokens = [path]
        out: set[Path] = set()
        if access == "command":
            # track `cd <dir>` so a following `../` is judged against that subdir
            cwd: Path | None = None  # None => anchor at the workspace root
            i = 0
            while i < len(tokens):
                tok = tokens[i]
                if tok == "cd" and i + 1 < len(tokens):
                    nxt = tokens[i + 1]
                    if nxt.startswith("~"):
                        # workspace.home(), not expanduser: in ssh mode `~` is
                        # the REMOTE user's home, never the app host's
                        nxt = str(workspace.home()) + nxt[1:]
                    base = cwd if cwd is not None else workspace.realpath(workspace.root)
                    # norm_join, not os.path: in ssh mode the token is judged
                    # against the remote layout (ntpath on Windows would
                    # backslash-rewrite it). shell_path first: the token is
                    # shell text, so /tmp on a Git-Bash host is %TEMP%
                    cwd = workspace.norm_join(str(base), workspace.shell_path(nxt))
                    i += 2
                    continue
                p = workspace.escape_path(workspace.shell_path(tok), cwd)
                if p is not None:
                    out.add(p)
                i += 1
        else:
            for tok in tokens:
                p = workspace.escape_path(tok)
                if p is not None:
                    out.add(p)
        return frozenset(out)


def _parse_args(args_repr: str) -> dict:
    try:
        parsed = json.loads(args_repr)
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


# How often a waiting ask re-checks that a UI is still attached, and how long
# the UI must be GONE before the ask is given up on. The grace is the point: an
# EventSource retry or a tunnel redial drops the SSE subscriber for a few
# seconds while the renderer's dialog is still on screen — a gap must not deny a
# prompt the user is about to answer. A connection that is gone for good (the
# wrongly-closed one) crosses it in ~half a minute and the ask stops wedging.
# The same grace covers the moment the prompt is HANDED OVER: a subscriber count
# of zero is a fact about one instant, and the instant a reconnect is dialing is
# exactly when it reads zero (see PermissionGate.require).
ATTACH_POLL_S = 1.0
DETACH_GRACE_S = 30.0

# How often a waiting ask is re-announced to the UI. An ask is not a one-shot
# frame: it is published ONCE to one stream, and a window can miss that frame —
# a reload mid-ask, an EventSource between reconnects, a renderer still
# reconstructing history (which drops live prompts on purpose, see
# ui/js/stream-events.js). What arrives once can be lost forever, and what is
# lost leaves the run blocked on a prompt nobody has ever seen. So while the ask
# waits it is sent again, keyed by the same request_id: a UI that shows it
# already renders the same dialog in place, one that never saw it finally can.
REANNOUNCE_S = 15.0


@dataclass
class _Ask:
    """One waiting prompt: the event its verdict sets, and what to re-announce.

    The details live here (not just the Event) because a prompt must outlast the
    frame that announced it: pending_asks() hands them to every (re)connecting
    stream, and the remind loop publishes them again while the ask waits."""

    done: threading.Event
    tool: str
    args_repr: str
    reason: str


class PermissionGate:
    """Bridge between the agent thread and the UI.

    The agent calls `require(tool, args, workspace, access)`: it evaluates
    permission and, if the action is "ask", blocks on a threading.Event until the
    UI responds via `resolve(request_id, allow)` — it waits as long as the user
    needs (no timeout, so the model never sees a spurious "permission request
    timed out"). The only ways out of the wait: the user allows/denies, the
    server's Stop resolves every pending ask as denied, or the UI is GONE — the
    prompt could not be handed to anyone (`on_ask` returned False) or the UI it
    was published to left — and stayed gone for the whole grace, in which case
    the action is denied rather than left hanging. "Nobody is watching right
    now" is never a verdict on its own: it is the same fact an EventSource
    reconnect produces for a second, so it only starts the clock
    (see DETACH_GRACE_S).
    """

    def __init__(
        self,
        evaluator: PermissionEvaluator,
        on_ask: Callable[[str, str, str, str], bool | None] | None = None,
        auto_allow: bool = False,
        is_attached: Callable[[], bool] | None = None,
        detach_grace_s: float = DETACH_GRACE_S,
        attach_poll_s: float = ATTACH_POLL_S,
        reannounce_s: float = REANNOUNCE_S,
    ) -> None:
        self.evaluator = evaluator
        # (request_id, tool, args_repr, reason) -> None to block, False when no
        # UI is attached to confirm (the gate then denies instead of hanging)
        self.on_ask = on_ask
        self.auto_allow = auto_allow
        # is a UI that can answer still there? asked again while a prompt waits
        # (None = nothing to ask, the wait is the plain blocking one)
        self.is_attached = is_attached
        self.detach_grace_s = detach_grace_s
        self.attach_poll_s = attach_poll_s
        self.reannounce_s = reannounce_s
        self._pending: dict[str, _Ask] = {}
        self._decisions: dict[str, bool] = {}
        self._lock = threading.Lock()
        self._counter = 0

    def require(self, tool: str, args_repr: str, workspace: Workspace, access: str, arg: str = "") -> None:
        """Raise PermissionRequired if the user must confirm (or deny).

        `tool` is only what the prompt calls the call; the POLICY reads `access`,
        the access the tool's own declaration is under (registry.access), and the
        argument it judges, named by that same declaration (registry.access_arg) —
        so a component installed later is subject to it without an edit here.
        Approved escapes are recorded on the workspace for the call; auto_allow
        (unattended/eval) denies escapes rather than silently opening the sandbox.
        """
        action = self.evaluator.evaluate(args_repr, workspace, access, arg)
        escapes = self.evaluator.escaped_paths(args_repr, workspace, access, arg)
        if action == "deny":
            raise PermissionRequired("", tool, args_repr, "denied by permission rules")
        if action == "allow" and not escapes:
            return
        if escapes:
            reason = f"access outside the workspace: {', '.join(sorted(str(p) for p in escapes))}"
        else:
            # no args here: the UI renders args_repr in a dedicated args box,
            # and the tool is already in the dialog's "Tool:" header — embedding
            # either here produced brace soup and duplicated names
            reason = f"permission {action}"
        # ask (by rule) or escape (by resolution)
        if self.auto_allow:
            if escapes:
                raise PermissionRequired("", tool, args_repr, "sandbox escape requires user approval")
            return  # non-escape rule ask auto-allowed (eval harness behavior)
        with self._lock:
            self._counter += 1
            request_id = f"perm-{self._counter}"
            ev = threading.Event()
            self._pending[request_id] = _Ask(ev, tool, args_repr, reason)
            self._decisions[request_id] = False

        def _remind() -> None:
            # the same ask again, under the same request_id: a window that
            # missed the first publish (a reload mid-ask, a reconnect, a
            # renderer still reconstructing history) finally sees the prompt
            self.on_ask(request_id, tool, args_repr, reason)

        if self.on_ask and self.on_ask(request_id, tool, args_repr, reason) is False:
            # nobody to publish to right now. With no attachment probe the
            # refusal is final (nothing will ever notice the UI coming back), so
            # deny rather than wait forever. WITH one it is not a verdict: the
            # zero this reads is a fact about one instant — the instant an
            # EventSource retry or a tunnel redial is between streams — and
            # denying there is how a read the user was about to approve comes
            # back to the model as "denied", which is exactly the reply that
            # teaches it to reach for run_command instead. So the refusal only
            # starts the clock: _await_decision gives a UI DETACH_GRACE_S to
            # (re)attach — the reminder keeps offering the prompt — and denies
            # with the same words if none does.
            if self.is_attached is None:
                with self._lock:
                    self._pending.pop(request_id, None)
                    self._decisions.pop(request_id, None)
                raise PermissionRequired(
                    request_id, tool, args_repr, "no user interface connected to confirm this action"
                )
            unattached_since: float | None = time.monotonic()
        else:
            unattached_since = None
        if not self._await_decision(ev, _remind if self.on_ask else None, unattached_since):
            # the UI this prompt was published to is gone and never came back:
            # nobody is left who CAN confirm, so answer exactly like on_ask's
            # "no UI attached" instead of wedging the run — an unanswered ask
            # keeps busy set forever, which keeps the supervisor from reaping
            # the session and the .clc write-locked with no window anywhere
            with self._lock:
                self._pending.pop(request_id, None)
                self._decisions.pop(request_id, None)
            raise PermissionRequired(
                request_id, tool, args_repr, "no user interface connected to confirm this action"
            )
        allowed = self._decisions.get(request_id, False)
        with self._lock:
            self._pending.pop(request_id, None)
            self._decisions.pop(request_id, None)
        if not allowed:
            raise PermissionRequired(request_id, tool, args_repr, "denied by user")
        workspace.allow(escapes)

    def _await_decision(self, ev: threading.Event, remind: Callable[[], None] | None = None,
                        gone_since: float | None = None) -> bool:
        """Wait for the user's answer; False when the audience is gone for good.

        No timeout while a UI is attached: the prompt stays up until the user
        confirms, however long that takes (a frozen phone in the background is
        still attached — its socket keeps the stream alive). What must NOT be
        waited out is a UI that is gone: a wrongly-closed connection leaves a
        prompt nobody can ever answer. So attachment is re-checked as the wait
        goes on, and only a gap longer than `detach_grace_s` counts as gone —
        see DETACH_GRACE_S for why a short gap is not a verdict.

        `gone_since` is the caller's own observation that the prompt reached
        nobody (a monotonic stamp, or None when it was handed over): a detached
        start counts against the same grace instead of restarting it.

        While the wait lasts, `remind` re-announces the prompt every
        `reannounce_s` (see REANNOUNCE_S): delivery is best-effort, and a run
        must not block forever on a prompt its window never saw. A reminder that
        cannot be delivered is not this loop's verdict — the attachment check
        above owns that.
        """
        announced = time.monotonic()
        while not ev.wait(self.attach_poll_s):
            now = time.monotonic()
            if remind is not None and now - announced >= self.reannounce_s:
                announced = now
                try:
                    remind()
                except Exception:  # noqa: BLE001 -- a reminder never ends the wait
                    pass
            if self.is_attached is None:
                # no probe (see __init__): the wait is the plain blocking one
                continue
            if self.is_attached():
                gone_since = None
                continue
            if gone_since is None:
                gone_since = now
            elif now - gone_since >= self.detach_grace_s:
                return False
        return True

    def resolve(self, request_id: str, allow: bool) -> bool:
        """Called by the server when the UI responds. Returns True if found.

        A resolved ask leaves `_pending` at once: it is no longer waiting, so it
        is never re-announced or re-delivered again (the decision stays until
        `require` reads it on its way out)."""
        with self._lock:
            ask = self._pending.pop(request_id, None)
            if ask is None:
                return False
            self._decisions[request_id] = allow
        ask.done.set()
        return True

    def pending_ids(self) -> list[str]:
        with self._lock:
            return list(self._pending)

    def pending_asks(self) -> list[tuple[str, str, str, str]]:
        """Every prompt still waiting: (request_id, tool, args_repr, reason).

        What a (re)connecting window is owed the moment its stream opens — an
        ask is STATE while it waits, not a frame that was sent once (see
        REANNOUNCE_S), because a prompt a window never saw blocks the run on a
        dialog nobody can answer."""
        with self._lock:
            return [(rid, a.tool, a.args_repr, a.reason) for rid, a in self._pending.items()]
