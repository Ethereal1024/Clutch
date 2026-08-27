"""CLI entry: python -m agent "task" or clutch "task"

Flags override the defaults in agent/config.py.
"""

from __future__ import annotations

import argparse
import sys
import traceback

from .config import Config
from .core.errors import AgentError
from .events import Event, event_to_json
from .llm.client import LlmClient
from .loop import Agent
from .tools.registry import ToolRegistry, build_default_tools
from .tools.sandbox import Sandbox


def _emit_sink(event: Event) -> None:
    print(event_to_json(event), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(prog="clutch", description="self-built coding agent")
    parser.add_argument("task", nargs="?", help="task description; empty shows help")
    parser.add_argument("--model", default=None)
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--sandbox", dest="sandbox_dir", default=None, help="sandbox dir (default: temp dir)")
    parser.add_argument("--verify", dest="verify_command", default=None, help="verification command template, {file} = game file")
    parser.add_argument("--game", dest="game_file", default=None, help="game file name")
    parser.add_argument("--max-turns", dest="max_turns", type=int, default=None)
    parser.add_argument("--log", dest="log_path", default=None, help="event log JSONL path")
    args = parser.parse_args()

    if not args.task:
        parser.print_help()
        return 2

    config = Config()
    for k, v in vars(args).items():
        if v is not None:
            setattr(config, k, v)

    try:
        llm = LlmClient(model=config.model, base_url=config.base_url)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    sandbox = Sandbox(config.sandbox_dir)
    print(f"[clutch] sandbox: {sandbox.root}", flush=True)

    agent = Agent(
        llm=llm,
        registry=ToolRegistry(build_default_tools(config)),
        sandbox=sandbox,
        config=config,
        sink=_emit_sink,
    )

    try:
        result = agent.run(args.task)
        print(f"[clutch] result: {result}", flush=True)
        return 0
    except AgentError as e:
        print(f"[clutch] fatal: {e}", file=sys.stderr)
        if e.detail:
            print(e.detail, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n[clutch] interrupted", file=sys.stderr)
        return 130
    except Exception:  # noqa: BLE001 -- last-resort guard, never lose the run
        traceback.print_exc()
        return 1
    finally:
        sandbox.cleanup()


if __name__ == "__main__":
    sys.exit(main())
