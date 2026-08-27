"""Loop termination conditions.

Layered termination:
- Inner (natural): model replies with no tool call => candidate done.
- Outer (verification gate): do NOT trust the model; run the verify command
  (demo game: `python3 <file> --test`). Pass => truly done; fail => feed back and retry.
  "Give the agent a way to verify its work" (Anthropic).
- Budget: max turns; doom-loop: N identical tool calls in a row => abort.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

from ..config import Config
from ..tools.sandbox import Sandbox
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
        return turn >= self.config.max_turns

    def verify(self, sandbox: Sandbox) -> TerminateResult:
        """Run the verification gate. No-op success if no command is configured."""
        cmd = self.config.verify_command.format(file=self.config.game_file)
        result = run_command(sandbox, self.config, cmd)
        ok = not result.get("error") and "ERROR" not in result.get("content", "")
        return TerminateResult(
            done=ok,
            status="completed" if ok else "verify_failed",
            reason="verify_gate_passed" if ok else "verify_gate_failed",
            verify_output=result.get("content", ""),
        )
