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

import re
import threading
from dataclasses import dataclass, field
from typing import Callable, List, Optional

from ..tools.workspace import Workspace

Action = str  # "allow" | "ask" | "deny"


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


DEFAULT_RULES: List[Rule] = [
    # danger: destructive/irreversible commands always ask
    Rule("ask", "run_command", r"\brm\s+-rf\b|\bsudo\b|\bshutdown\b|\breboot\b|\bmkfs\b|\bdd\b\s"),
    # commands that delete anything ask
    Rule("ask", "run_command", r"^\s*rm\b"),
    Rule("ask", "run_command", r"\bmv\s+.*\s/\s"),
    # writing outside the workspace asks
    Rule("ask", "write_file", r"(\.\./|^/|~)"),
    Rule("ask", "run_command", r"(\.\./|^/)"),
]


def _default_rules() -> List[Rule]:
    return [Rule(r.action, r.tool, r.pattern) for r in DEFAULT_RULES]


@dataclass
class PermissionEvaluator:
    rules: List[Rule] = field(default_factory=_default_rules)

    def evaluate(self, tool: str, args_repr: str, workspace: Workspace) -> Action:
        # For run_command, rules match the actual command, not the JSON envelope.
        # Extract it so `rm ...` etc. is matched correctly.
        match_text = args_repr
        if tool == "run_command":
            import json as _json

            try:
                parsed = _json.loads(args_repr)
                if isinstance(parsed, dict) and "command" in parsed:
                    match_text = parsed["command"]
            except (ValueError, TypeError):
                pass
        # last matching rule wins (opencode findLast semantics)
        decision: Optional[Rule] = None
        for rule in self.rules:
            if rule.matches(tool, match_text):
                decision = rule
        if decision is not None:
            return decision.action
        return "allow"


class PermissionGate:
    """Bridge between the agent thread and the UI.

    The agent calls `require(tool, args, workspace)`: it evaluates permission and,
    if the action is "ask", blocks on a threading.Event until the UI responds via
    `resolve(request_id, allow)`. The evaluator lives in the loop; the gate is
    supplied by the server so the UI can actually resolve requests.
    """

    def __init__(
        self,
        evaluator: PermissionEvaluator,
        on_ask: Optional[Callable[[str, str, str, str], None]] = None,
        auto_allow: bool = False,
    ) -> None:
        self.evaluator = evaluator
        self.on_ask = on_ask  # (request_id, tool, args_repr, reason) -> None
        self.auto_allow = auto_allow
        self._pending: dict[str, threading.Event] = {}
        self._decisions: dict[str, bool] = {}
        self._lock = threading.Lock()
        self._counter = 0

    def require(self, tool: str, args_repr: str, workspace: Workspace) -> None:
        """Raise PermissionRequired if the user must confirm (or deny)."""
        action = self.evaluator.evaluate(tool, args_repr, workspace)
        if action == "allow":
            return
        if action == "deny":
            raise PermissionRequired("", tool, args_repr, "denied by permission rules")
        # action == "ask"
        if self.auto_allow:
            return
        with self._lock:
            self._counter += 1
            request_id = f"perm-{self._counter}"
            ev = threading.Event()
            self._pending[request_id] = ev
            self._decisions[request_id] = False
        reason = f"permission {action}: {tool} with args {args_repr[:120]}"
        if self.on_ask:
            self.on_ask(request_id, tool, args_repr, reason)
        if not ev.wait(timeout=60):
            raise PermissionRequired(request_id, tool, args_repr, "permission request timed out")
        allowed = self._decisions.get(request_id, False)
        with self._lock:
            self._pending.pop(request_id, None)
            self._decisions.pop(request_id, None)
        if not allowed:
            raise PermissionRequired(request_id, tool, args_repr, "denied by user")

    def resolve(self, request_id: str, allow: bool) -> bool:
        """Called by the server when the UI responds. Returns True if found."""
        with self._lock:
            ev = self._pending.get(request_id)
            if ev is None:
                return False
            self._decisions[request_id] = allow
        ev.set()
        return True

    def pending_ids(self) -> List[str]:
        with self._lock:
            return list(self._pending)
