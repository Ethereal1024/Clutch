"""GET /api/session: the facts one turn is asked with (P1-4).

Run: .venv/bin/python -m tests.session_api_test

The host's loop (`ui/run-host.js`) builds the messages a turn is asked with from
five machine facts, and ends the turn with the sixth; this is where it gets them.
What this suite pins:

  1. The shape is exactly the six keys, no more, no less.
  2. `mode` mirrors the session's configured mode; `shell` is the local shell
     this host actually speaks; `components` is the resolved prose
     `registry.prompt_section` returns (not a second reading).
  3. `contextWindowBytes` is the session's configured budget (default 500 000).
  4. `memory` is null with no project open, and {path, bytes} with one — the
     path is the .clc file and the bytes is the log's current size.
  5. `limits` is the session's own termination numbers — the turn budget and the
     doom-loop guard the client's loop enforces (P4-3) — read from the config
     rather than from any constant of the API's.
  6. No project open is 200 (the host may build a run-host before one opens),
     and the endpoint writes nothing to the .clc.
"""

from __future__ import annotations

import json
import tempfile
import threading
from pathlib import Path

from agent.base import Broadcaster, RunState
from agent.config import Config
from agent.project import create_project
from agent.server import build
from agent.tools import localshell
from agent.tools.registry import prompt_section
from tests.testsupport import check, http_get


def open_server(tmp: Path, name: str, **cfg_fields) -> tuple:
    """A real server (routing + handler wiring), with NO project open."""
    path = tmp / name / f"{name}.clc"
    path.parent.mkdir(parents=True, exist_ok=True)
    project = create_project(path, name, model="fake-model")
    cfg = Config(host="127.0.0.1", port=0, **cfg_fields)
    state = RunState()
    srv = build(cfg, Broadcaster(), state)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{cfg.port}", cfg, state, project, srv


def session(base: str) -> tuple[int, dict, str]:
    status, text = http_get(f"{base}/api/session")
    try:
        return status, json.loads(text), text
    except json.JSONDecodeError:  # pragma: no cover
        check(False, f"/api/session answers JSON (got {status}: {text[:200]})")
        raise


def main() -> None:
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)

        # ---- 1. shape, no project open -----------------------------------
        base, cfg, state, project, srv = open_server(tmp, "shape")
        status, body, _text = session(base)
        check(status == 200, "no project open is answered 200, not 409")
        check(
            sorted(body) == ["components", "contextWindowBytes", "limits", "memory", "mode", "shell"],
            "the answer carries exactly the six facts a turn is asked (and ended) with",
        )
        check(body["mode"] == cfg.mode, "mode mirrors the session's configured mode")
        check(body["shell"] == localshell.local_shell().name, "shell is the shell this host actually speaks")
        check(
            body["components"] == prompt_section(cfg),
            "components is the resolved prose registry returns, not a second reading",
        )
        check(body["memory"] is None, "memory is null with no project open")
        check(
            body["contextWindowBytes"] == cfg.llm_context_window_bytes,
            "contextWindowBytes is the session's configured budget",
        )
        check(
            body["limits"]
            == {
                "max_turns": cfg.max_turns,
                "doom_loop_limit": cfg.doom_loop_limit,
                "abort_on_doom_loop": cfg.abort_on_doom_loop,
            },
            "limits is the session's configured termination numbers (defaults included)",
        )
        srv.shutdown()

        # ---- 2. a project open fills memory ------------------------------
        base2, cfg2, state2, project2, srv2 = open_server(tmp, "withproject")
        state2.project = project2
        status2, body2, _text2 = session(base2)
        check(status2 == 200, "a session with a project open answers 200")
        check(body2["memory"] is not None, "memory is present when a project is open")
        check(body2["memory"]["path"] == str(project2.path), "memory.path is the .clc file path")
        check(body2["memory"]["bytes"] == project2.log.file_bytes(), "memory.bytes is the log's current size")
        # the mode still mirrors config (default work)
        check(body2["mode"] == cfg2.mode, "mode mirrors the session's configured mode (with project)")
        srv2.shutdown()

        # ---- 3. chat mode, and limits that are not the defaults -------------
        base3, cfg3, state3, _project3, srv3 = open_server(tmp, "chat", mode="chat")
        status3, body3, _text3 = session(base3)
        check(body3["mode"] == "chat", "a chat-mode session reports chat")
        srv3.shutdown()

        # the guard's numbers are the CONFIG's, not constants of the endpoint: a
        # session started with its own budget and doom window serves those
        base3b, cfg3b, _state3b, _project3b, srv3b = open_server(
            tmp, "limits", max_turns=7, doom_loop_limit=2, abort_on_doom_loop=False
        )
        status3b, body3b, _text3b = session(base3b)
        check(
            body3b["limits"] == {"max_turns": 7, "doom_loop_limit": 2, "abort_on_doom_loop": False},
            "limits mirrors the config this session was started with, not a default",
        )
        srv3b.shutdown()

        # ---- 4. the .clc is not written ----------------------------------
        base4, cfg4, state4, project4, srv4 = open_server(tmp, "nowrite")
        state4.project = project4
        before = project4.log.file_bytes()
        status4, _body4, _text4 = session(base4)
        check(project4.log.file_bytes() == before, "the endpoint writes nothing to the .clc")
        srv4.shutdown()

        # ---- 5. the route is exact ---------------------------------------
        base5, cfg5, state5, _project5, srv5 = open_server(tmp, "route")
        status5, text5 = http_get(f"{base5}/api/sessions")  # trailing s is a misspelling
        check(status5 == 404, "a misspelled path is still 404 (the route table is exact)")
        check(json.loads(text5).get("error") == "not found", "and says so in the API's one shape")
        srv5.shutdown()

    print("session_api: ok")


if __name__ == "__main__":
    main()
