"""One machine's model-facing tool surface, as JSON — the oracle for P3-1.

`ui/tool-decl.js` is the frontend's reading of the same declarations
(agent/tools/catalog.py's parser is the copy P4 deletes). Until then the two
readings must answer identically, and this script is how the JS test gets the
Python answer: it builds the surface through the REAL pipeline (catalog table ->
build_tools -> ToolRegistry) over the manifests this repo ships, and prints the
result.

Two seams are patched, and both are facts about a machine rather than about a
declaration:

  * `registry._drivable` — whether a component's code is here (rendezvous.available)
    is the machine's answer, not the declaration's. The dump answers "here" for
    every component whose declaration the host can READ (the fatal diagnostics
    are still catalog's own, the same filter the real _drivable applies), so the
    comparison is about the declarations and not about what is installed.
  * `answers._fact_answer` — a published host fact (`$skills`) is answered by
    running the component's own statement. The dump answers a fixed one instead,
    so the check does not need that component's code on the machine.

Everything else (merge, diagnostics, defaults, `$config`/`$backends`/`$skills`,
mode/gate, the derived `mutates`/`undo`, `path_arg`) is the real code. The
components the host REFUSES are printed too (`refused`), so the JS reading can
be held to the same refusals.

Run: .venv/bin/python tests/tool_decl_dump.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# The components this repo develops: a dev checkout beside the repo IS a
# registration, and these are the manifests the frontend must read identically.
CHECKOUTS = (
    "clutch-memory",
    "clutch-skills",
    "clutch-workspace",
    "clutch-ssh-workspace",
    "clutch-websearch",
)

# The machine's own values, fixed so the two readings are compared on one input.
READ_MAX_CHARS = 4321
WEB_SEARCH_MAX_RESULTS = 6
WEB_SEARCH_TIMEOUT = 17.0
SKILLS = ("alpha", "beta")


class _Log:
    """The open project log the `project` gate asks about (path is what it reads)."""

    path = "/tmp/tool-decl/project.clc"


def surface() -> dict:
    from agent.config import Config
    from agent.tools import answers, catalog, components, facts, modules, registry

    with tempfile.TemporaryDirectory() as root:
        repo = Path(root) / "repo"
        repo.mkdir()
        for name in CHECKOUTS:
            source = REPO / name / components.MANIFEST
            if not source.is_file():
                continue
            directory = repo / name
            directory.mkdir()
            shutil.copyfile(source, directory / components.MANIFEST)
        os.environ[components.ROOT_ENV] = str(Path(root) / "install")
        os.environ["CLUTCH_COMPONENTS_CATALOG"] = str(Path(root) / "catalog.d")

        saved_root = modules.repo_root
        saved_fact = answers._fact_answer
        saved_drivable = registry._drivable
        modules.repo_root = lambda: repo  # type: ignore[method-assign]
        catalog.invalidate()
        answers._fact_answer = lambda token, config: facts.Answer(  # type: ignore[method-assign]
            tuple(facts.Entry(name, f"{name} skill") for name in SKILLS), owner="clutch-skills"
        )
        def _drivable():  # type: ignore[no-redef]
            """The real filter with availability answered "here".

            catalog's own refusals still apply (a declaration naming a word the
            host cannot read contributes nothing), so the two readings are
            compared on what the host would really offer.
            """
            out = []
            for component in catalog.table().values():
                if any(d.fatal for d in catalog.component_diagnostics(component)):
                    continue
                out.append(component)
            return out

        registry._drivable = _drivable  # type: ignore[method-assign]
        try:
            config = Config(
                mode="work",
                read_max_chars=READ_MAX_CHARS,
                web_search_max_results=WEB_SEARCH_MAX_RESULTS,
                web_search_timeout=WEB_SEARCH_TIMEOUT,
            )
            registry_ = registry.ToolRegistry(registry.build_tools(config, log=_Log()))
            tools = [
                {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": spec.parameters,
                    "schema": spec.to_openai_schema(),
                    "ui": registry_.ui(spec.name),
                    "access": registry_.access(spec.name),
                    "access_arg": registry_.access_arg(spec.name),
                    "path_arg": registry_.path_arg(spec.name),
                }
                for spec in (registry_.tool(name) for name in registry_.names())
            ]
            return {
                "declarations": catalog.registrations(),
                "config": {
                    "read_max_chars": READ_MAX_CHARS,
                    "web_search_max_results": WEB_SEARCH_MAX_RESULTS,
                    "web_search_timeout": WEB_SEARCH_TIMEOUT,
                },
                "backends": list(catalog.available_backends(config)),
                "facts": {"skills": list(SKILLS)},
                "host": {
                    "ui": catalog.DEFAULTS,
                    "access": {word: {"arg": rec.arg} for word, rec in catalog.ACCESS_WORDS.items()},
                    "gates": dict(catalog.GATE_WORDS),
                },
                "project": True,
                "mode": "work",
                "tools": tools,
                # What the host refuses, so the frontend's own refusals can be
                # held to the same set (a retired word, `entry` beside a process).
                "refused": {
                    component.name: [d.message for d in catalog.component_diagnostics(component) if d.fatal]
                    for component in catalog.table().values()
                    if any(d.fatal for d in catalog.component_diagnostics(component))
                },
            }
        finally:
            modules.repo_root = saved_root  # type: ignore[method-assign]
            answers._fact_answer = saved_fact  # type: ignore[method-assign]
            registry._drivable = saved_drivable  # type: ignore[method-assign]


def main(argv: list[str]) -> int:
    json.dump(surface(), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
