"""Evaluation harness: run each eval scenario through the agent and record results.

This is a standalone dev/eval tool, decoupled from the product. The agent core
never references it.

An eval scenario dir contains:
  task.md      - the prompt given to the agent
  seed/        - files copied into a fresh workspace before the run
  verify.sh    - verification gate command (run inside the workspace)

The harness drives the agent through the same BaseServer contract as the HTTP
server (build_llm/build_tools/build_workspace/start_task), so eval and product
share one run-assembly path.

Usage:
  uv run python -m eval.harness [--scenario s2_landing] [--repeat N]

Output: one JSONL line per run under reports/ with scenario, pass/fail, turns,
duration and the workspace path (so artifacts are inspectable).
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from agent.base import BaseServer, Broadcaster, RunState  # noqa: E402
from agent.config import Config  # noqa: E402
from agent.events import EventLog, event_to_json  # noqa: E402
from agent.project import Project  # noqa: E402
from agent.tools.workspace import LocalWorkspace, Workspace  # noqa: E402

SCENARIOS_DIR = Path(__file__).resolve().parent


class HarnessServer(BaseServer):
    """Eval host: each scenario runs in a fresh temp workspace."""

    def build_workspace(self, project: Project) -> Workspace:
        return LocalWorkspace(str(project.workdir))


def run_scenario(scenario_dir: Path, config: Config, report_dir: Path, tag: str = "") -> dict:
    task = (scenario_dir / "task.md").read_text(encoding="utf-8").strip()
    verify_cmd = (scenario_dir / "verify.sh").read_text(encoding="utf-8").strip().splitlines()[0]

    run_cfg = Config(
        verify_command=verify_cmd,
        max_turns=config.max_turns,
        model=config.model,
        non_interactive=True,
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
        "workspace": "",
    }
    try:
        with tempfile.TemporaryDirectory() as root:
            # seed -> fresh workspace, then assemble the run through BaseServer
            seed = scenario_dir / "seed"
            if seed.exists():
                shutil.copytree(seed, Path(root), dirs_exist_ok=True)
            project = Project(path=Path(root) / "harness.clc")
            server = HarnessServer(run_cfg, Broadcaster(), RunState())
            agent = server.start_task(task, project, on_ask=None)
            log: EventLog = project.log
            outcome["workspace"] = str(root)

            try:
                result = agent.run(task)
                outcome["result"] = result
                outcome["turns"] = len([e for e in log.events() if e.type == "step_start"])
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
    except Exception as e:  # noqa: BLE001 -- assembly failure still records a report
        outcome["result"] = f"EXCEPTION: {e}"
        outcome["duration_s"] = round(time.time() - started, 1)
        traceback.print_exc()
    return outcome


def main() -> int:
    parser = argparse.ArgumentParser(prog="harness")
    parser.add_argument("--scenario", default=None, help="run only this scenario dir name")
    parser.add_argument("--repeat", type=int, default=1, help="times to repeat each scenario")
    parser.add_argument("--max-turns", type=int, default=25)
    parser.add_argument("--model", default=Config().model)
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
            tag = "" if args.repeat == 1 else f"run{i + 1}"
            print(f"[harness] running {sd.name} {tag}", flush=True)
            o = run_scenario(sd, config, report_dir, tag)
            results.append(o)
            print(
                f"  -> {'PASS' if o['pass'] else 'FAIL'} {o['result'][:60]} turns={o['turns']} {o['duration_s']}s",
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
