"""Loop termination conditions.

Termination is natural: a model reply with no tool call and some text is done.
- Budget: max turns caps how long a run can go.
- Doom-loop: N identical tool calls (same name, arguments AND result) in a row =>
  feed a warning back once; repeating the exact warned call then aborts (or keeps
  feeding feedback when abort_on_doom_loop=False).
"""

from __future__ import annotations

from ..config import Config


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
