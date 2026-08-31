"""Loop termination conditions.

Layered termination:
- Inner (natural): model replies with no tool call => candidate done.
- Outer (verification gate): if the caller supplied a verify command (e.g. a test
  suite), do NOT trust the model; run that command. Pass => truly done; fail =>
  feed the output back and retry. "Give the agent a way to verify its work"
  (Anthropic). Empty command = no gate, natural termination only.
- Budget: max turns; doom-loop: N identical tool calls (same name, arguments AND
  result) in a row => feed a warning back once; repeating the exact warned call
  then aborts (or keeps feeding feedback when abort_on_doom_loop=False).
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import Config
from ..tools.transport import TransportError
from ..tools.workspace import Workspace


@dataclass
class TerminateResult:
    done: bool = False
    status: str = ""
    reason: str = ""
    verify_output: str = ""


class Terminator:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._last_calls: list[tuple[str, str, str]] = []  # (name, args, result)
        self._doom_warned = False
        self._doom_call: tuple[str, str] | None = None  # (name, args) the warning is about

    def should_escalate(self, name: str, args_repr: str) -> bool:
        """Pre-execution: True if this exact call repeats a warned doom call.

        Called before the tool runs so an escalating call is never executed again.
        """
        return self._doom_warned and (name, args_repr) == self._doom_call

    def record_call(self, name: str, args_repr: str, result_content: str) -> str:
        """Record a tool call and its result; return "warn" on first doom detection.

        A doom loop is N consecutive identical calls: same name, same arguments AND
        the same result content. Identical calls whose results change (polling,
        flaky tests) are progress, not a loop — they never trigger.

        The first detection returns "warn" and arms escalation for that exact call;
        the caller feeds the warning back and keeps going. A different call forgives
        the warning (the model moved on), so a later legitimate use of the same tool
        starts a fresh cycle instead of aborting an old one.
        """
        if self.should_escalate(name, args_repr):
            return "escalate"
        if self._doom_warned:
            # the model moved on: forgive the warning, tracking resumes fresh
            self._doom_warned = False
            self._doom_call = None
        self._last_calls.append((name, args_repr, result_content))
        if len(self._last_calls) > self.config.doom_loop_limit:
            self._last_calls.pop(0)
        if len(self._last_calls) == self.config.doom_loop_limit and all(
            c == self._last_calls[0] for c in self._last_calls
        ):
            self._doom_warned = True
            self._doom_call = (name, args_repr)
            self._last_calls.clear()  # the warning resets the window
            return "warn"
        return ""

    def check_turn_budget(self, turn: int) -> bool:
        # max_turns=0 means no limit (compaction keeps long runs going)
        return self.config.max_turns > 0 and turn > self.config.max_turns

    def verify(self, workspace: Workspace) -> TerminateResult:
        """Run the verification gate. No command configured => pass-through."""
        cmd = self.config.verify_command
        if not cmd:
            return TerminateResult(done=True, status="completed", reason="no_verify_command")
        result = run_verify(workspace, self.config, cmd)
        # judge by exit status, not by scanning text (a self-test may legitimately
        # print "ERROR" while exercising error paths)
        ok = not result.get("error")
        return TerminateResult(
            done=ok,
            status="completed" if ok else "verify_failed",
            reason="verify_gate_passed" if ok else "verify_gate_failed",
            verify_output=result.get("content", ""),
        )


def run_verify(workspace: Workspace, config: Config, command: str) -> dict:
    """Run the verify command through the workspace transport (trusted input, no tool guards)."""
    try:
        r = workspace.run(command, config.command_timeout)
    except TransportError as e:
        if not e.timeout:
            raise
        return {"content": f"ERROR: verify command timed out ({config.command_timeout:.0f}s)", "error": True}
    body = _format_output(config, r)
    if r.code != 0:
        text = "\n".join(body) if body else "(no output)"
        return {"content": f"ERROR: verify command failed (exit {r.code})\n{text}", "error": True}
    text = "OK: verify command succeeded"
    if body:
        text += "\n" + "\n".join(body)
    return {"content": text}


def _format_output(config: Config, r) -> list[str]:
    parts = []
    if r.stdout:
        parts.append("stdout:\n" + config.truncate(r.stdout))
    if r.stderr:
        parts.append("stderr:\n" + config.truncate(r.stderr))
    return parts
