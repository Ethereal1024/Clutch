"""GET /api/session: the facts one turn is asked with (P1-4).

The host's loop (`ui/run-host.js`) needs four facts to build the messages a
model turn is asked with — the mode contract, the components' own prose, the
local shell name, and the project memory anchor — and it needs the model window
size to know when to compact. These are machine facts: the session knows the
shell, the project knows the log's byte count, the config knows the window
budget and the mode. The host can derive the components prose only from the
same registrations it just read; serving the RESOLVED text here avoids a
second round trip from the host to each component directory.

The five keys:

  mode               "work" | "chat" — the session's configured default
  shell              "bash" | "cmd" | "posix-sh" (localshell.local_shell().name)
  components         the installed components' own words about their own tools,
                     joined (registry.prompt_section); "" when none do
  contextWindowBytes the model context budget this session was started with
                     (Config.llm_context_window_bytes, default 500 000)
  memory             {path, bytes} — the project .clc file path and its current
                     byte count, so the recall anchor can say "here it is and it
                     is THIS big"; null when no project is open

There is no 409 here: a session that has not yet opened a project has four of
the five facts; the host may call this before it opens one (in fact it builds
the run-host before the first task, and the first task opens a project via the
session's /api/project/* path). Memory null simply omits the recall anchor —
the system prompt's memory section is "only when there is a file behind it".
"""

from __future__ import annotations

from ..tools.localshell import local_shell
from ..tools.registry import prompt_section


class SessionMixin:
    "The facts a host loop turn is assembled from: mode, shell, components, window, memory."

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
            }
        )
