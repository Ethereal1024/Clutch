"""Repro: what the model actually receives from web_search, and what web_fetch
does with the URLs in it. Runs the real component over the real host path.

Run: .venv/bin/python scripts/_web_repro.py "your query"
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from agent.config import Config
from agent.tools import catalog, inst, modules, rendezvous, workspace

cfg = Config()
ws = workspace.LocalWorkspace(str(Path.cwd()))
mod = catalog.table()[modules.WEBSEARCH]
specs = {t.name: t for t in mod.tools}
stmt = rendezvous.prepare(mod.name, ws, cfg)


def call(name: str, args: dict) -> dict:
    spec = specs[name]
    line = f"{stmt.prefix} {inst.render(spec.command, args, vars=stmt.vars)}".strip()
    res = stmt.runner.run(line, cfg.command_timeout)
    env = inst.unwrap(res, service=f"the {mod.name} service")
    print(f"\n$ {line}\n--- model-visible result ---\n{env.get('content')}\n--- end ---")
    return env


query = sys.argv[1] if len(sys.argv) > 1 else "python 3.13 whatsnew release notes"
env = call("web_search", {"query": query, "max_results": 3})
urls = re.findall(r"https?://[^\s)\]>,]+", env.get("content") or "")
print(f"\nURLs the model can copy: {len(urls)}")
for u in urls[:3]:
    print("   ", u)
for u in urls[:2]:
    call("web_fetch", {"url": u, "max_chars": 400})
