"""Loop termination conditions.

Layered termination:
- Inner (natural): model replies with no tool call => candidate done.
- Outer (verification gate): if the caller supplied a verify command (e.g. a test
  suite), do NOT trust the model; run that command. Pass => truly done; fail =>
  feed the output back and retry. "Give the agent a way to verify its work"
  (Anthropic). Empty command = no gate, natural termination only.
- Budget: max turns; doom-loop: N identical tool calls in a row => abort.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

from ..config import Config
from ..tools.workspace import Workspace
from ..tools.shell import run_command


@dataclass
class TerminateResult:
    done: bool = False
    status: str = ""
    reason: str = ""
    verify_output: str = ""


class Terminator:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._last_calls: List[Tuple[str, str]] = []

    def record_call(self, name: str, args_repr: str) -> bool:
        """Record a tool call; return True if a doom loop is detected."""
        self._last_calls.append((name, args_repr))
        if len(self._last_calls) > self.config.doom_loop_limit:
            self._last_calls.pop(0)
        if len(self._last_calls) == self.config.doom_loop_limit:
            if all(c == self._last_calls[0] for c in self._last_calls):
                return True
        return False

    def check_turn_budget(self, turn: int) -> bool:
        return turn > self.config.max_turns

    def verify(self, workspace: Workspace) -> TerminateResult:
        """Run the verification gate. No command configured => pass-through."""
        cmd = self.config.verify_command
        if not cmd:
            return TerminateResult(done=True, status="completed", reason="no_verify_command")
        result = run_command(workspace, self.config, cmd)
        # judge by exit status, not by scanning text (a self-test may legitimately
        # print "ERROR" while exercising error paths)
        ok = not result.get("error")
        return TerminateResult(
            done=ok,
            status="completed" if ok else "verify_failed",
            reason="verify_gate_passed" if ok else "verify_gate_failed",
            verify_output=result.get("content", ""),
        )
