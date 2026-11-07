"""GET /api/session: the facts one turn is asked with (P1-4).

The host's loop (`ui/run-host.js`) needs four facts to build the messages a
model turn is asked with — the mode contract, the components' own prose, the
local shell name, and the project memory anchor — and it needs the model window
size to know when to compact. These are machine facts: the session knows the
shell, the project knows the log's byte count, the config knows the window
budget and the mode. The host can derive the components prose only from the
same registrations it just read; serving the RESOLVED text here avoids a
second round trip from the host to each component directory.

It also has to know when to STOP. The turn budget and the doom-loop guard used
to be the backend loop's own checks (the retired agent/core/terminate.py, P4-3);
the loop is the client's now, so the numbers behind them are served as DATA and
enforced where the turns are taken. They stay the session's numbers: a limit is
something the session was configured with (agent/config.py), and a threshold the
client invented for itself would be a second answer to "how long may this run".

The six keys:

  mode               "work" | "chat" — the session's configured default
  shell              "bash" | "cmd" | "posix-sh" (localshell.local_shell().name)
  components         the installed components' own words about their own tools,
                     joined (registry.prompt_section); "" when none do
  contextWindowBytes the model context budget this session was started with
                     (Config.llm_context_window_bytes, default 500 000)
  memory             {path, bytes} — the project .clc file path and its current
                     byte count, so the recall anchor can say "here it is and it
                     is THIS big"; null when no project is open
  limits             {max_turns, doom_loop_limit, abort_on_doom_loop} — the
                     run's termination knobs, in the config's own names: after
                     this many model turns the turn is closed as aborted (0 =
                     no budget, because compaction keeps long runs going); N
                     identical calls in a row (same name, arguments AND result)
                     earn one warning and then either abort the turn or keep
                     earning feedback. A doom limit of 0 turns the guard off.

There is no 409 here: a session that has not yet opened a project has five of
the six facts; the host may call this before it opens one (in fact it builds
the run-host before the first task, and the first task opens a project via the
session's /api/project/* path). Memory null simply omits the recall anchor —
the system prompt's memory section is "only when there is a file behind it".
"""

from __future__ import annotations

from ..tools.localshell import local_shell
from ..tools.registry import prompt_section


class SessionMixin:
    "The facts a host loop turn is assembled from: mode, shell, components, window, memory, limits."

    def _session_get(self) -> None:
        cfg = self._cfg
        project = self._state.project
        memory = (
            None
            if project is None
            else {
                "path": str(project.path),
                "bytes": project.log.file_bytes(),
            }
        )
        self._json(
            {
                "mode": cfg.mode,
                "shell": local_shell().name,
                # registry.prompt_section(cfg) reads each drivable component's
                # `prompt` file and resolves $config / $backends / $skills tokens
                # exactly as it does for a Python run; serving the resolved text
                # avoids duplicating that resolution on the host side.
                "components": prompt_section(cfg),
                "contextWindowBytes": cfg.llm_context_window_bytes,
                "memory": memory,
                # The client's loop enforces these (ui/run.js); the names are the
                # config's because they are the config's numbers (P4-3).
                "limits": {
                    "max_turns": cfg.max_turns,
                    "doom_loop_limit": cfg.doom_loop_limit,
                    "abort_on_doom_loop": cfg.abort_on_doom_loop,
                },
            }
        )
