"""Evaluation harness: run each eval scenario through the agent and record results.

This is a standalone dev/eval tool, decoupled from the product. The agent core
never references it.

An eval scenario dir contains:
  task.md      - the prompt given to the agent
  seed/        - files copied into a fresh sandbox before the run
  verify.sh    - verification gate command (run inside the sandbox)

Usage:
  uv run python -m eval.harness [--scenario s2_landing] [--repeat N]

Output: one JSONL line per run under reports/ with scenario, pass/fail, turns,
duration and the sandbox path (so artifacts are inspectable).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import traceback
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from agent.config import Config  # noqa: E402
from agent.core.terminate import Terminator  # noqa: E402
from agent.events import EventLog, event_to_json  # noqa: E402
from agent.llm.client import LlmClient  # noqa: E402
from agent.loop import Agent  # noqa: E402
from agent.tools.registry import ToolRegistry, build_default_tools  # noqa: E402
from agent.tools.sandbox import Sandbox  # noqa: E402

SCENARIOS_DIR = Path(__file__).resolve().parent


def run_scenario(scenario_dir: Path, config: Config, report_dir: Path, tag: str = "") -> dict:
    task = (scenario_dir / "task.md").read_text(encoding="utf-8").strip()
    verify_cmd = (scenario_dir / "verify.sh").read_text(encoding="utf-8").strip().splitlines()[0]

    sandbox = Sandbox()
    # seed -> fresh sandbox
    seed = scenario_dir / "seed"
    if seed.exists():
        shutil.copytree(seed, sandbox.root, dirs_exist_ok=True)

    run_cfg = Config(
        verify_command=verify_cmd,
        max_turns=config.max_turns,
        model=config.model,
    )
    llm = LlmClient(model=config.model)
    log = EventLog()
    agent = Agent(
        llm=llm,
        registry=ToolRegistry(build_default_tools(run_cfg)),
        sandbox=sandbox,
        config=run_cfg,
        log=log,
    )

    started = time.time()
    outcome = {
        "scenario": scenario_dir.name,
        "tag": tag,
        "ts": time.strftime("%Y%m%d-%H%M%S"),
        "pass": False,
        "result": "",
        "turns": 0,
        "duration_s": 0.0,
        "sandbox": str(sandbox.root),
    }
    try:
        result = agent.run(task)
        outcome["result"] = result
        outcome["turns"] = len(
            [e for e in log.events() if e.type == "step_start"]
        )
        outcome["pass"] = result != "ABORTED"
    except Exception as e:  # noqa: BLE001
        outcome["result"] = f"EXCEPTION: {e}"
        traceback.print_exc()
    finally:
        outcome["duration_s"] = round(time.time() - started, 1)
        # persist the event log alongside the report for replay/debug
        report_dir.mkdir(parents=True, exist_ok=True)
        log_path = report_dir / f"{outcome['scenario']}-{outcome['tag'] or outcome['ts']}.jsonl"
        with open(log_path, "a", encoding="utf-8") as f:
            for ev in log.events():
                f.write(event_to_json(ev) + "\n")
        sandbox.cleanup()
    return outcome


def main() -> int:
    parser = argparse.ArgumentParser(prog="harness")
    parser.add_argument("--scenario", default=None, help="run only this scenario dir name")
    parser.add_argument("--repeat", type=int, default=1, help="times to repeat each scenario")
    parser.add_argument("--max-turns", type=int, default=25)
    parser.add_argument("--model", default="deepseek-v4-flash")
    args = parser.parse_args()

    config = Config(model=args.model, max_turns=args.max_turns)
    report_dir = BASE / "reports"
    report_dir.mkdir(exist_ok=True)

    scenarios = [d for d in sorted(SCENARIOS_DIR.iterdir()) if (d / "task.md").exists()]
    if args.scenario:
        scenarios = [d for d in scenarios if d.name == args.scenario]

    results = []
    for sd in scenarios:
        for i in range(args.repeat):
            tag = "" if args.repeat == 1 else f"run{i+1}"
            print(f"[harness] running {sd.name} {tag}", flush=True)
            o = run_scenario(sd, config, report_dir, tag)
            results.append(o)
            print(
                f"  -> {'PASS' if o['pass'] else 'FAIL'} "
                f"{o['result'][:60]} turns={o['turns']} {o['duration_s']}s",
                flush=True,
            )

    # summary
    passed = sum(1 for r in results if r["pass"])
    print(f"\n[{passed}/{len(results)} passed]")
    for r in results:
        mark = "PASS" if r["pass"] else "FAIL"
        print(f"  {mark}  {r['scenario']:<16} {r['result'][:50]}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
