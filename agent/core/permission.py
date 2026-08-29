"""Permission engine: decide whether a tool call may proceed.

Adapted from opencode's permission model (ruleset of allow/ask/deny, find-last
match, default allow inside the workspace). The safety model is "confirm, don't
hide": the agent works in the user's directory, and risky actions prompt the user
instead of being sandboxed away.

Decision flow for one tool call:
  evaluate(tool, args, workspace) -> Action
    allow  -> execute
    ask    -> publish a permission request, block until the user replies
    deny   -> feed an error back to the model

Rules are evaluated in order; the LAST matching rule wins (opencode findLast).
The default action is allow for anything inside the workspace.
"""

from __future__ import annotations

import json
import re
import shlex
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..tools.workspace import Workspace

Action = str  # "allow" | "ask" | "deny"

# tools whose path/command args can reference the filesystem
_PATH_TOOLS = {"read_file", "write_file", "edit_file", "revert_file", "list_dir", "grep", "run_command"}


@dataclass
class Rule:
    action: Action
    tool: str = "*"  # tool name or "*"
    pattern: str = ""  # regex on the args; empty = match any args

    def matches(self, tool: str, args_repr: str) -> bool:
        if self.tool != "*" and self.tool != tool:
            return False
        if not self.pattern:
            return True
        try:
            return re.search(self.pattern, args_repr, re.IGNORECASE) is not None
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
    Rule("ask", "run_command", r"\brm\s+-rf\b|\bsudo\b|\bshutdown\b|\breboot\b|\bmkfs\b|\bdd\b\s"),
    # commands that delete anything ask
    Rule("ask", "run_command", r"^\s*rm\b"),
    Rule("ask", "run_command", r"\bmv\s+.*\s/\s"),
    # writing outside the workspace asks
    Rule("ask", "write_file", r"(\.\./|^/|~)"),
    Rule("ask", "run_command", r"(\.\./|^/)"),
]

# how much of the args JSON to surface in an ask reason
_ARGS_REPR_MAX = 120


@dataclass
class PermissionEvaluator:
    rules: list[Rule] = field(default_factory=lambda: list(DEFAULT_RULES))

    def evaluate(self, tool: str, args_repr: str, _workspace: Workspace) -> Action:
        # Rules match the ACTUAL argument they guard, not the whole JSON envelope:
        # run_command matches the command; write_file matches the target path.
        # Matching against the full args would flag e.g. a report whose CONTENT
        # contains "~" or "../" — content is data, not a path, and must never
        # prompt a write it doesn't touch.
        match_text = args_repr
        if tool in ("run_command", "write_file"):
            key = "command" if tool == "run_command" else "path"
            try:
                parsed = json.loads(args_repr)
                if isinstance(parsed, dict) and key in parsed:
                    match_text = parsed[key]
            except (ValueError, TypeError):
                pass
        # last matching rule wins (opencode findLast semantics)
        decision: Rule | None = None
        for rule in self.rules:
            if rule.matches(tool, match_text):
                decision = rule
        if decision is not None:
            return decision.action
        return "allow"

    def escaped_paths(self, tool: str, args_repr: str, workspace: Workspace) -> frozenset[Path]:
        """Absolute paths outside the workspace root this call references, resolved
        for real (not regex-matched): read/write/list_dir/grep use their ``path``
        arg, run_command every command token. Empty means the call stays in the
        sandbox. These are what the user approves when an escape is asked for."""
        if tool not in _PATH_TOOLS:
            return frozenset()
        args = _parse_args(args_repr)
        if tool == "run_command":
            try:
                tokens = shlex.split((args.get("command") or "").strip())
            except ValueError:
                return frozenset()
        else:
            path = args.get("path")
            if path is None:
                return frozenset()
            tokens = [path]
        root = workspace.root
        out: set[Path] = set()
        for tok in tokens:
            if not tok:
                continue
            try:
                p = (root / tok).resolve()
            except (OSError, ValueError):
                continue  # un-resolvable token: not a filesystem path
            if not p.is_relative_to(root):
                out.add(p)
        return frozenset(out)


def _parse_args(args_repr: str) -> dict:
    try:
        parsed = json.loads(args_repr)
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        return {}


class PermissionGate:
    """Bridge between the agent thread and the UI.

    The agent calls `require(tool, args, workspace)`: it evaluates permission and,
    if the action is "ask", blocks on a threading.Event until the UI responds via
    `resolve(request_id, allow)` — it waits as long as the user needs (no timeout,
    so the model never sees a spurious "permission request timed out"). The only
    ways out of the wait: the user allows/denies, the server's Stop resolves every
    pending ask as denied, or `on_ask` reports that no UI is attached (returns
    False), in which case the action is denied rather than left hanging.
    """

    def __init__(
        self,
        evaluator: PermissionEvaluator,
        on_ask: Callable[[str, str, str, str], bool | None] | None = None,
        auto_allow: bool = False,
    ) -> None:
        self.evaluator = evaluator
        # (request_id, tool, args_repr, reason) -> None to block, or False when no
        # UI is attached to confirm (the gate then denies instead of hanging)
        self.on_ask = on_ask
        self.auto_allow = auto_allow
        self._pending: dict[str, threading.Event] = {}
        self._decisions: dict[str, bool] = {}
        self._lock = threading.Lock()
        self._counter = 0

    def require(self, tool: str, args_repr: str, workspace: Workspace) -> None:
        """Raise PermissionRequired if the user must confirm (or deny).

        On approval the approved external paths are recorded on the workspace so
        the tool's resolve() may touch them; the loop clears them after the call.
        Escapes always require a real human (or interactive caller): auto_allow
        (eval/unattended) denies them rather than silently opening the sandbox.
        """
        action = self.evaluator.evaluate(tool, args_repr, workspace)
        escapes = self.evaluator.escaped_paths(tool, args_repr, workspace)
        if action == "deny":
            raise PermissionRequired("", tool, args_repr, "denied by permission rules")
        if action == "allow" and not escapes:
            return
        if escapes:
            reason = f"access outside the workspace: {', '.join(sorted(str(p) for p in escapes))}"
        else:
            reason = f"permission {action}: {tool} with args {args_repr[:_ARGS_REPR_MAX]}"
        # ask (by rule) or escape (by resolution)
        if self.auto_allow:
            if escapes:
                raise PermissionRequired("", tool, args_repr, "sandbox escape requires user approval")
            return  # non-escape rule ask auto-allowed (eval harness behavior)
        with self._lock:
            self._counter += 1
            request_id = f"perm-{self._counter}"
            ev = threading.Event()
            self._pending[request_id] = ev
            self._decisions[request_id] = False
        if self.on_ask and self.on_ask(request_id, tool, args_repr, reason) is False:
            # nobody can see/answer the prompt (renderer disconnected): deny rather
            # than wait forever on an invisible request
            with self._lock:
                self._pending.pop(request_id, None)
                self._decisions.pop(request_id, None)
            raise PermissionRequired(request_id, tool, args_repr, "no user interface connected to confirm this action")
        ev.wait()  # no timeout: the prompt stays up until the user confirms
        allowed = self._decisions.get(request_id, False)
        with self._lock:
            self._pending.pop(request_id, None)
            self._decisions.pop(request_id, None)
        if not allowed:
            raise PermissionRequired(request_id, tool, args_repr, "denied by user")
        workspace.allow(escapes)

    def resolve(self, request_id: str, allow: bool) -> bool:
        """Called by the server when the UI responds. Returns True if found."""
        with self._lock:
            ev = self._pending.get(request_id)
            if ev is None:
                return False
            self._decisions[request_id] = allow
        ev.set()
        return True

    def pending_ids(self) -> list[str]:
        with self._lock:
            return list(self._pending)
