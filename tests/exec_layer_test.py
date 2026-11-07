"""The machine keeps the execution layer — and nothing of the loop.

Why this exists. P4 deleted the agent loop from `agent/`: the client now drives
every turn and the machine only executes what it is asked (`/api/exec`, the log,
the workspace, the session facts). A directory listing does not show that split.
`agent/prompts/` still sits in the tree (execution text the model reads) and
nothing says which side of the line a given module is on. Two failures follow
from that blindness:

  1. the loop creeps back in through one import — a single
     `from .context import derive_messages` in a route and the machine is
     assembling the model's messages again, which is the thing P4 removed;
  2. a module that only tests import stays forever, so `agent/` becomes
     half-execution-half-remnant and no listing shows it.

Both are import-graph facts, so this runner reads the graph instead of trusting
the tree: start at the only two ways `agent/` is ever launched — `python -m
agent.server`, and the frozen `agent-supervisor` whose entry is
`agent/supervisor.py` (scripts/supervisor_entry.py imports `main` from it) — and
follow every import (relative, absolute, `from . import x`, and
`importlib.import_module("…")` literals). Tests are deliberately NOT part of the
graph: a module only they import is, by definition, not on the machine's
execution path.

Checks:
  1. exactly two `__main__` guards under agent/ — the two walk roots ARE the
     entry surface, so "reachable" cannot be dodged by a third launcher
  2. every module under agent/ is reachable from one of them — there is no
     exception list any more: the loop's projector is gone, so anything left
     unreachable is a remnant
  3. agent.core.context does not exist, nothing imports it, and the name
     `derive_messages` is no identifier anywhere under agent/ — the projector is
     not merely unused, it is absent from the execution layer
  4. the same split in prompt TEXT: `agent/prompts/` is imported by the
     execution layer for its `errors/*` messages and its `tools/*` prose, and
     its top-level .md files are exactly that execution text — the loop's
     assembly (system/mode/task/compaction/env) lives in `ui/prompts/`, which
     the HOST renders
  5. `agent/` imports nothing outside the stdlib and itself: no model client, no
     HTTP client — there is nothing on the machine to call a model WITH
  6. the execution layer really is wired (agent.api.exec,
     agent.tools.{registry,rendezvous,components}, agent.tools.recall,
     agent.supervisor): "reachable" is not vacuously satisfied by an empty graph
  7. no import statement anywhere in the repo still names a retired loop module
     (agent.loop, agent.llm, agent.core.compaction, agent.api.run): comments may
     describe them, imports may not — an import is an ImportError at startup, a
     comment is not
  8. the walker itself: a synthetic package proves relative imports,
     `from . import x`, absolute imports and `import_module` literals are all
     followed, that a re-exported NAME is not mistaken for a module, and that an
     unimported module is reported as the orphan it is

Run: python -m tests.exec_layer_test
"""

from __future__ import annotations

import ast
import sys
import tempfile
from collections.abc import Iterable
from pathlib import Path

from tests.testsupport import collecting_check

ROOT = Path(__file__).resolve().parent.parent
AGENT = ROOT / "agent"

# The two ways agent/ is launched (see the docstring). Both are shipped: the
# frozen server bundle is built from agent/server.py, the frozen supervisor from
# scripts/supervisor_entry.py -> agent.supervisor.
ENTRY = ("agent.server", "agent.supervisor")

# The only module under agent/ that nothing shipped imports: none. The loop's
# projector used to be here; it is deleted, so this stays empty — a new orphan
# must be argued for in this file, not discovered by the runner.
ORPHANS: dict[str, str] = {}

# Modules of the RETIRED loop. Nothing may import them (they no longer exist, so
# an import is an ImportError at startup, not a warning).
RETIRED = ("agent.loop", "agent.llm", "agent.core.compaction", "agent.api.run")

# The half P4 kept: these MUST be on the shipped graph, or "reachable" means
# nothing. One per endpoint named in agent/server.py's docstring.
WIRED = (
    "agent.api.exec",
    "agent.tools.registry",
    "agent.tools.rendezvous",
    "agent.tools.components",
    "agent.tools.recall",
    "agent.supervisor",
)

IMPORT_CALLS = ("import_module", "__import__")

# Top-level prompt files that are EXECUTION text (a tool result the model reads),
# not the loop's assembly: registry.py answers an unknown tool with this one.
EXEC_TEXT = {"unknown_tool.md"}

check, failures = collecting_check()


# --- the walker -------------------------------------------------------------


def module_file(base: Path, name: str) -> Path | None:
    """The file Python would load for dotted `name` under `base`, or None when
    the name is not a module there (a class, a function re-export, a stdlib or
    third-party name) — those are dependencies to skip, not failures."""
    parts = name.split(".")
    if not all(parts) or not (base / parts[0]).exists():
        return None
    module = base.joinpath(*parts).with_suffix(".py")
    if module.is_file():
        return module
    package = base.joinpath(*parts, "__init__.py")
    return package if package.is_file() else None


def package_of(name: str, path: Path) -> str:
    """The package a module's own relative imports are relative to."""
    if path.name == "__init__.py":
        return name
    return name.rsplit(".", 1)[0] if "." in name else ""


def imports_of(path: Path, name: str) -> list[str]:
    """Every dotted name this module's imports could mean, as candidates: the
    import itself, plus each NAME it pulls in (which may be a submodule —
    `from . import lazy` — or just a symbol, which module_file() then rejects)."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    pkg = package_of(name, path)
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                # level 1 = this package, level n = n-1 packages up
                parts = pkg.split(".") if pkg else []
                head = parts[: max(len(parts) - (node.level - 1), 0)]
                base = ".".join([*head, base] if base else head)
            if not base:
                continue
            out.append(base)
            out.extend(f"{base}.{alias.name}" for alias in node.names if alias.name != "*")
        elif isinstance(node, ast.Call):
            fn = node.func
            called = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
            if called in IMPORT_CALLS and node.args:
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    out.append(arg.value)
    return out


def reachable(base: Path, roots: Iterable[str]) -> dict[str, Path]:
    """The import graph from `roots`, following only names that resolve under
    `base`. Ancestor packages are included because importing a.b.c executes
    a/__init__.py and a/b/__init__.py — their imports are reached too."""
    seen: dict[str, Path] = {}
    stack = list(roots)
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        path = module_file(base, name)
        if path is None:
            continue
        seen[name] = path
        parts = name.split(".")
        stack.extend(".".join(parts[:i]) for i in range(1, len(parts)))
        stack.extend(imports_of(path, name))
    return seen


def all_modules(base: Path) -> dict[str, Path]:
    """Every importable module under `base`, as agent/ modules are named."""
    found: dict[str, Path] = {}
    for path in sorted(base.rglob("*.py")):
        rel = path.relative_to(base).with_suffix("")
        parts = list(rel.parts)
        if parts[-1] == "__init__":
            parts.pop()
        if parts:
            found[".".join([base.name, *parts])] = path
    return found


def guarded_modules(base: Path) -> list[str]:
    """Modules with a `if __name__ == "__main__":` block — the launch surface."""
    out = []
    for name, path in all_modules(base).items():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
                continue
            test = node.test
            names = [n for n in [test.left, *test.comparators] if isinstance(n, ast.Name)]
            others = [n for n in [*test.comparators] if isinstance(n, ast.Constant)]
            if any(n.id == "__name__" for n in names) and any(
                n.value == "__main__" for n in others
            ):
                out.append(name)
                break
    return out


def module_name(path: Path) -> str:
    """The dotted name a repo file is imported as (tests/… and scripts/… are not
    packages, but their own relative imports are none of this runner's business:
    only level-0 names are read from them)."""
    rel = path.relative_to(ROOT).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def import_names(paths: Iterable[Path]) -> list[tuple[Path, str]]:
    """Every dotted name imported by these files, paired with its file."""
    return [(path, dep) for path in paths for dep in imports_of(path, module_name(path))]


def python_files(*dirs: Path) -> list[Path]:
    return [p for d in dirs for p in sorted(d.rglob("*.py"))]


# --- the checks -------------------------------------------------------------


def check_entry_surface() -> None:
    guards = sorted(guarded_modules(AGENT))
    print("entry surface (if __name__ == '__main__'):", ", ".join(guards))
    check(guards == sorted(ENTRY),
          f"exactly the two shipped entry points guard a main: {', '.join(ENTRY)}")


def check_graph() -> dict[str, Path]:
    modules = all_modules(AGENT)
    reached = reachable(ROOT, ENTRY)
    orphans = sorted(set(modules) - set(reached))
    print(f"\nthe shipped graph: {len(reached)} of {len(modules)} modules under agent/")
    print("not on it:", ", ".join(orphans) or "(none)")
    for name in orphans:
        print(f"  {name} — {ORPHANS.get(name, 'UNEXPLAINED')} "
              f"({len(modules[name].read_text(encoding='utf-8').splitlines())} lines)")
    check(orphans == sorted(ORPHANS),
          "every module under agent/ is reachable from the two shipped entries")
    for name in ENTRY:
        check(name in reached, f"{name} is on the graph it starts")
    return reached


def check_projector_absent(reached: dict[str, Path]) -> None:
    print("\nthe loop's projector, agent.core.context:")
    check(not (AGENT / "core" / "context.py").exists(), "the module is deleted")
    check("agent.core.context" not in reached, "unreachable from either entry point")

    importers = sorted({str(p.relative_to(ROOT)) for p, dep in
                        import_names(python_files(AGENT, ROOT / "tests", ROOT / "scripts"))
                        if dep == "agent.core.context"})
    print("  imported by:", " ".join(importers) or "(nothing)")
    check(not importers, "nothing imports it any more, not even a test")

    users = [name for name, path in all_modules(AGENT).items()
             if "derive_messages" in identifiers(path)]
    check(not users,
          "no shipped module carries the identifier derive_messages — a comment "
          "may mention it, code may not")


def identifiers(path: Path) -> set[str]:
    """The identifier names a module's code contains: names used, attributes
    reached, imported aliases and things it defines. Comments and docstrings are
    text, not identifiers, so a comment describing the retired projector is not
    a hit — a resurrected call to it is."""
    out: set[str] = set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            out.add(node.id)
        elif isinstance(node, ast.Attribute):
            out.add(node.attr)
        elif isinstance(node, ast.Import):
            out.update(alias.name.rsplit(".", 1)[-1] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            out.update(alias.name for alias in node.names)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(node.name)
    return out


def check_prompts(reached: dict[str, Path]) -> None:
    """The same split in prompt TEXT: agent/prompts/ is imported by the execution
    layer (errors/*, and the tools/* prose in host.py's computed `tools/<n>.md`),
    and its top-level .md files are exactly the execution text — an answer the
    model reads, never the loop's assembly. The loop's words live in ui/prompts/
    and are rendered by the HOST (tests/prompt.test.js pins that side)."""
    prompts = AGENT / "prompts"
    shipped: dict[str, str] = {}
    for name, path in all_modules(AGENT).items():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            fn = node.func
            called = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
            arg = node.args[0]
            if called != "render" or not isinstance(arg, ast.Constant) or not isinstance(arg.value, str):
                continue
            if name in reached:
                shipped.setdefault(arg.value, name)

    print("\nthe loop's prompt text:")
    print("  rendered by shipped code:", ", ".join(sorted(shipped)))
    check(all((prompts / t).is_file() for t in shipped),
          "every template the execution layer renders exists on disk")
    loop_text = sorted(t for t in shipped if "/" not in t and t not in EXEC_TEXT)
    check(not loop_text,
          "no top-level template (the loop's system/mode/task/compaction/env text) "
          f"is rendered by shipped code: {', '.join(loop_text) or 'none'}")
    top = sorted(p.name for p in prompts.glob("*.md"))
    print(f"  top-level .md files on disk: {', '.join(top) or '(none)'}")
    check(top == sorted(EXEC_TEXT),
          "the top-level .md files left under agent/prompts/ are exactly the "
          f"execution text: {', '.join(sorted(EXEC_TEXT))}")
    print("  (the loop's words are ui/prompts/ now: the client renders them,")
    print("   tests/prompt.test.js holds that side of the split)")


def check_no_model_client() -> None:
    third = sorted({
        root.split(".")[0]
        for _, dep in import_names(python_files(AGENT))
        for root in [dep]
        if root.split(".")[0] not in sys.stdlib_module_names and root.split(".")[0] != "agent"
    })
    check(not third,
          f"agent/ imports nothing outside the stdlib and itself ({', '.join(third) or 'none'})")


def check_wired(reached: dict[str, Path]) -> None:
    print("\nthe execution layer is actually on the graph:")
    for name in WIRED:
        check(name in reached, name)


def check_no_stale_imports() -> None:
    stale = [(str(p.relative_to(ROOT)), dep)
             for p, dep in import_names(python_files(AGENT, ROOT / "tests", ROOT / "scripts"))
             if any(dep == r or dep.startswith(r + ".") for r in RETIRED)]
    for where, dep in stale:
        print(f"  stale: {where} imports {dep}")
    check(not stale, "no import statement still names a retired loop module")


FIXTURE = {
    "__init__.py": "from . import alpha\n",
    "alpha.py": "from .beta import thing\nimport meta.gamma\n",
    "beta.py": "thing = 1\n",
    "gamma.py": "import importlib\nm = importlib.import_module('meta.delta')\n",
    "delta.py": "",
    "unused.py": "import os\n",
}


def check_walker() -> None:
    """The runner is only as good as the walker: prove it on a package whose
    answer is known, including the two shapes it must NOT invent modules for."""
    print("\nthe walker itself (fixtures):")
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp) / "meta"
        base.mkdir()
        for name, text in FIXTURE.items():
            (base / name).write_text(text, encoding="utf-8")
        reached = reachable(base.parent, ["meta"])
        found = sorted(reached)
        orphans = sorted(set(all_modules(base)) - set(reached))
        print("  reachable:", " ".join(found))
        check(found == ["meta", "meta.alpha", "meta.beta", "meta.delta", "meta.gamma"],
              "relative import, `from . import x`, absolute import and import_module are followed")
        check("meta.beta.thing" not in reached,
              "a re-exported NAME (`from .beta import thing`) is not mistaken for a module")
        check(orphans == ["meta.unused"],
              "a module nothing imports is reported as the one orphan")


def main() -> int:
    check_entry_surface()
    reached = check_graph()
    check_projector_absent(reached)
    check_prompts(reached)
    check_no_model_client()
    check_wired(reached)
    check_no_stale_imports()
    check_walker()

    if failures:
        print(f"\nexec_layer_test: {len(failures)} FAILED")
        return 1
    print("\nexec_layer_test: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
