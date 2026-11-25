"""The Python floor: 3.8, and the gate that keeps the declaration honest.

Why 3.8. Ubuntu 20.04 is an LTS with a long tail of GUI hosts, and its system
python3 is 3.8.10 — the interpreter a remote machine actually has when the app
hands it the server's sources (`pylibs`, scripts/build-pylibs-tar.sh). Declaring
a higher floor does not upgrade those machines, it refuses them: the tar is
interpreter-agnostic (stdlib only, empty site-packages) precisely so that an
older remote can run it, and `ui/src/host/tunnel-bootstrap.ts` turns the
declaration into a sentence at the door ("target runs python 3.6 … the server's
sources declare python 3.8 or newer") instead of an ImportError inside the
user's first request.

Where the number is declared — one number, four places, and they must agree:
  * pyproject.toml, clutch-workspace/pyproject.toml, clutch-skills/pyproject.toml
    — `requires-python`, plus ruff's `target-version`: the linter's idea of "too
    new" has to be the same idea as the declaration, or it happily passes code
    the floor cannot import (it did: `dict[str, Any]` in a module-level alias).
    The two component checkouts are git SUBMODULES: a bare checkout (what the
    cheap `verify` job has) holds none of their files, and CI deliberately does
    not make a release depend on a submodule being checked out. So this scan
    covers whatever is checked out, says so when a component tree is missing,
    and the `verify-py38` leg is the one that checks them out — which is where
    the components' own declaration is enforced.
  * ui/src/host/tunnel-bootstrap.ts — `PY_FLOOR`, the value that REFUSES a
    remote, so it is not documentation: it is the version gate.
  * .github/workflows/release.yml — the `verify-py38` leg, which `deb` needs and
    every other asset inherits through it, so a tree that only runs on 3.12
    reaches no release.

What a declaration needs is a gate, because nothing else notices. The failures
this module was written against were all silent on a 3.12 dev box: PEP 585/604
subscripts in a module-level alias (`GuardImpl = Callable[[…], Envelope | None]`
— `from __future__ import annotations` does not cover an alias, it is an
ordinary expression), `dict | dict` (PEP 584 is 3.9), `Path.write_text(newline=)`
and `zip(strict=)` (3.10), `str.removeprefix` (3.9), `sys.stdlib_module_names`
(3.10), a parenthesized `with (a, b):` that 3.8 parses as ONE tuple and dies on
with `AttributeError: __enter__`. `agent/` failed to import on 3.8 in ten places
before a single test ran, and no job in this pipeline had ever executed a python
interpreter older than the runner's.

Checks (offline, stdlib only, and itself 3.8-clean — it runs on the floor as
well as on a dev box):
  1. every shipped source parses under the floor's own grammar
     (`ast.parse(..., feature_version=FLOOR)`), which is what catches syntax
     additions a newer interpreter accepts on both sides of the AST
  2. nothing an IMPORT evaluates is newer than the floor: PEP 585/604 written in
     a signature of a module without `from __future__ import annotations`, and
     the same written in a module-level alias, which the future import never
     covers
  3. no API added after the floor, from a small table of the additions that are
     plausible here, plus an UNGUARDED module-level import of a 3.9+ stdlib
     module (a `try: import tomllib / except ModuleNotFoundError:` fallback is
     the idiom that supports both, and it is not a violation)
  4. the four declarations agree — a floor raised in one place and forgotten in
     the others is how a "declared" floor stops being true
  5. the scan itself, on the shapes this project was actually bitten by

What this cannot see, and why the CI leg runs the suite too. `x | y` between two
CALLS is indistinguishable from integer flag arithmetic in an AST (`set(a) |
set(b)` is legitimate on 3.8, `a() | b()` — a dict merge — is not), so no static
scan can promise the floor: `tests/settings_test.py`'s `DEFAULTS | {...}` and
`agent/tools/settings.py`'s merge were both found by RUNNING the suite on 3.8.
The same ambiguity makes an alias union of two class names (`Alias = Foo | Bar`)
indistinguishable from a mask of constants (`NAMES = READ | WRITE`), so this
module only claims the shapes PEP 604 is actually written in — `X | None`, or a
builtin on one side. This module is the cheap net that also runs in `verify` on
3.12; the authority is `verify-py38`.

Run: python3 -m tests.py38_check
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

from tests.testsupport import collecting_check

ROOT = Path(__file__).resolve().parent.parent
FLOOR = (3, 8)
FLOOR_VERSION = ".".join(str(part) for part in FLOOR)      # "3.8"
REQUIRES_PYTHON = ">=" + FLOOR_VERSION                      # ">=3.8"
RUFF_TARGET = "py%d%d" % FLOOR                              # "py38"

# What the floor has to cover: the server's own code, the two components this
# repo is the source of (their packages are what a remote executes), the runners
# the 3.8 leg runs, and the build scripts.
SCAN_ROOTS = ("agent", "tests", "scripts", "clutch-workspace", "clutch-skills")
# Vendored/generated trees, and the eval seeds: a seed is a stranger's project
# and is held to THAT project's interpreter, not to ours.
SKIP = {".git", ".venv", "node_modules", "__pycache__", "tmp", "dist", "build",
        "vendor", ".pytest_cache"}

PYPROJECTS = ("pyproject.toml", "clutch-workspace/pyproject.toml", "clutch-skills/pyproject.toml")
TUNNEL = "ui/src/host/tunnel-bootstrap.ts"
WORKFLOW = ".github/workflows/release.yml"

# Calls whose KEYWORD only exists after the floor: (attribute/function, keyword, added).
NEW_KWARGS = (
    ("write_text", "newline", "3.10"),
    ("write_bytes", "newline", "3.10"),
    ("zip", "strict", "3.10"),
)

# Methods added after the floor, matched on the bare attribute name: each one is
# a name no type in this codebase uses for anything else, so the reading is a
# method call and not a false alarm. The qualified ones below are matched as a
# dotted path instead, because `os.walk` and `Path.walk` share a name.
NEW_METHODS = {
    "removeprefix": "3.9",
    "removesuffix": "3.9",
    "is_relative_to": "3.9",
    "with_stem": "3.9",
    "hardlink_to": "3.10",
    "bit_count": "3.10",
}
NEW_QUALIFIED = {
    "functools.cache": "3.9",
    "itertools.pairwise": "3.10",
    "ast.unparse": "3.9",
    "sys.stdlib_module_names": "3.10",
    "datetime.UTC": "3.11",
}
# `from <module> import <name>` is the other way to reach a post-floor API.
NEW_FROM_IMPORTS = {
    ("functools", "cache"): "3.9",
    ("itertools", "pairwise"): "3.10",
    ("ast", "unparse"): "3.9",
    ("sys", "stdlib_module_names"): "3.10",
    ("types", "NoneType"): "3.10",
}
# Whole modules a 3.8 interpreter does not have. Only an UNGUARDED module-level
# import is a violation: try/except ModuleNotFoundError is the fallback idiom.
NEW_MODULES = {"graphlib": "3.9", "zoneinfo": "3.9", "tomllib": "3.11"}

# The names 3.8 cannot subscript or `|` — PEP 585 builtins and the PEP 604 union
# spelling. Anything here in an evaluated position is a TypeError at import.
BUILTIN_GENERICS = {"dict", "list", "tuple", "set", "frozenset", "type"}
TYPE_NAMES = BUILTIN_GENERICS | {"int", "str", "float", "bool", "bytes", "object", "complex"}

check, failures = collecting_check()


# ----------------------------------------------------------------- the sources --

def sources() -> list[Path]:
    """Every python file the floor has to hold, in a stable order."""
    out: list[Path] = []
    for root in SCAN_ROOTS:
        base = ROOT / root
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.py")):
            rel = path.relative_to(ROOT)
            if SKIP & set(rel.parts):
                continue
            # A component's OWN suite runs on the component repo's pytest matrix,
            # not here: what this floor covers is the package that ships.
            if rel.parts[0].startswith("clutch-") and "tests" in rel.parts:
                continue
            out.append(path)
    return out


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def parse(path: Path) -> tuple[str, ast.Module]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return text, ast.parse(text, filename=str(path))


def has_future_annotations(tree: ast.Module) -> bool:
    """True when every annotation in this module is a string at import time."""
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "__future__":
            if any(alias.name == "annotations" for alias in node.names):
                return True
    return False


# --------------------------------------------------------------- the three scans

def syntax_problems(paths: list[Path]) -> list[str]:
    """Every source that the floor's own parser rejects.

    `feature_version` is the portable half of this gate: it makes a NEWER
    interpreter refuse what the floor cannot parse (a parenthesized `with`, a
    `match` statement, `except*`), so `verify` on 3.12 catches it too instead of
    waiting for the 3.8 leg.
    """
    out: list[str] = []
    for path in paths:
        text = path.read_text(encoding="utf-8", errors="replace")
        try:
            ast.parse(text, filename=str(path), feature_version=FLOOR)
        except SyntaxError as exc:
            out.append("%s:%s: %s" % (rel(path), exc.lineno, exc.msg))
    return out


def dotted(node: ast.AST) -> str:
    """`functools.cache` for an Attribute chain of Names, else "" — how a call or
    an attribute read is compared against the qualified tables."""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return ""
    parts.append(node.id)
    return ".".join(reversed(parts))


def pep585_or_604(node: ast.AST) -> str:
    """Why this ANNOTATION expression is newer than the floor ("" when it is not).

    An annotation has no arithmetic meaning, so any `|` in one is PEP 604 and the
    reading is unambiguous — unlike a module-level alias, which `alias_problem()`
    has to be careful about.
    """
    for inner in ast.walk(node):
        if isinstance(inner, ast.Subscript):
            base = dotted(inner.value) or getattr(inner.value, "id", "")
            if base in BUILTIN_GENERICS:
                return "`%s[...]` is a PEP 585 subscript (3.9)" % base
        elif isinstance(inner, ast.BinOp) and isinstance(inner.op, ast.BitOr):
            return "`X | Y` is a PEP 604 union (3.10)"
    return ""


def alias_problem(node: ast.AST) -> str:
    """Why a MODULE-LEVEL assignment builds something newer than the floor.

    `from __future__ import annotations` covers annotations and nothing else: an
    alias is an ordinary expression that runs at import, which is how
    `GuardImpl = Callable[[Workspace, Config, dict[str, Any], str], Envelope | None]`
    got past ruff, pyright and every test on a 3.12 dev box.

    The `|` half is narrow on purpose, and narrower than it could be: `FLAGS = 1 | 2`,
    a mask of constants (`NAMES = READ | WRITE`) and a set union
    (`ALL = A | B`) are all ordinary 3.8 arithmetic, and an AST cannot tell
    `READ` from `Envelope`. So what counts is the shape PEP 604 is actually
    written in — a union with a `None` side, or with a builtin type on it — and a
    union of two CLASS names in an alias is left to the leg that runs the floor.
    """
    for inner in ast.walk(node):
        if isinstance(inner, ast.Subscript):
            base = dotted(inner.value) or getattr(inner.value, "id", "")
            if base in BUILTIN_GENERICS:
                return "`%s[...]` is a PEP 585 subscript (3.9)" % base
        elif isinstance(inner, ast.BinOp) and isinstance(inner.op, ast.BitOr):
            if any(isinstance(side, (ast.Set, ast.Dict, ast.List, ast.Tuple))
                   for side in (inner.left, inner.right)):
                continue  # a set/collection literal: `|` is 3.8-legal and means union
            for side in (inner.left, inner.right):
                if isinstance(side, ast.Constant) and side.value is None:
                    return "`X | None` is a PEP 604 union (3.10)"
                if isinstance(side, ast.Name) and side.id in TYPE_NAMES:
                    return "`%s | …` is a PEP 604 union (3.10)" % side.id
    return ""


def annotation_problems(tree: ast.Module, label: str) -> list[str]:
    """Annotations and aliases that 3.8 evaluates and cannot build.

    Only evaluated positions: with `from __future__ import annotations` every
    annotation is a string, so signatures and AnnAssign are exempt — aliases are
    not, and that asymmetry is exactly the bug this check exists for.
    """
    evaluated = not has_future_annotations(tree)
    out: list[str] = []

    def note(node: ast.AST, what: str, reason: str) -> None:
        if reason:
            out.append("%s:%s: %s — %s" % (label, getattr(node, "lineno", 0), what, reason))

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and evaluated:
            args = node.args
            every = list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)
            every += [a for a in (args.vararg, args.kwarg) if a is not None]
            for arg in every:
                if arg.annotation is not None:
                    note(arg.annotation, "argument `%s` of `%s`" % (arg.arg, node.name),
                         pep585_or_604(arg.annotation))
            if node.returns is not None:
                note(node.returns, "return of `%s`" % node.name, pep585_or_604(node.returns))
        elif isinstance(node, ast.AnnAssign) and evaluated and node.annotation is not None:
            note(node.annotation, "annotated assignment", pep585_or_604(node.annotation))

    for stmt in module_level_statements(tree):
        if isinstance(stmt, (ast.Assign, ast.AugAssign)):
            note(stmt.value, "module-level alias", alias_problem(stmt.value))
    return out


def module_level_statements(tree: ast.Module) -> list[ast.stmt]:
    """`tree.body`, plus the body of every class in it: both run at import."""
    out: list[ast.stmt] = list(tree.body)
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            out.extend(item for item in node.body if isinstance(item, (ast.Assign, ast.AugAssign)))
    return out


def guarded_imports(tree: ast.Module) -> set[int]:
    """Ids of the imports a `try:` block wraps — the fallback idiom.

    `try: import tomllib / except ModuleNotFoundError: tomllib = None` is how a
    3.8 module reads a config file with 3.11's parser, and it is not a
    violation: the code that needs the newer module runs only where it exists.
    What fails on the floor is an import that cannot fall back.
    """
    guarded: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        wrapper = ast.Module(body=list(node.body), type_ignores=[])
        guarded.update(id(inner) for inner in ast.walk(wrapper))
    return guarded


def api_problems(tree: ast.Module, text: str, label: str) -> list[str]:
    """APIs and imports added after the floor, in the small set this codebase
    plausibly reaches for. A table and not a rule: `sys` gained a dozen names
    between 3.8 and 3.12, and the ones below are the ones this tree reaches for.
    """
    lines = text.splitlines()
    out: list[str] = []
    guarded = guarded_imports(tree)
    called = {id(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}

    def note(node: ast.AST, what: str, added: str) -> None:
        line = getattr(node, "lineno", 0)
        source = lines[line - 1].strip() if 0 < line <= len(lines) else ""
        out.append("%s:%s: %s (needs %s) — %s" % (label, line, what, added, source))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            bare = dotted(node.func) if not isinstance(node.func, ast.Attribute) else node.func.attr
            for func, keyword, added in NEW_KWARGS:
                if bare == func and any(kw.arg == keyword for kw in node.keywords):
                    note(node, "`%s(%s=…)`" % (func, keyword), added)
            qualified = dotted(node.func)
            if qualified in NEW_QUALIFIED:
                note(node, "`%s()`" % qualified, NEW_QUALIFIED[qualified])
            elif bare in NEW_METHODS:
                note(node, "`.%s()`" % bare, NEW_METHODS[bare])
        elif isinstance(node, ast.Attribute):
            # `sys.stdlib_module_names` is READ, not called; the called form is
            # already reported above (and only once, hence the `called` set).
            qualified = dotted(node)
            if qualified in NEW_QUALIFIED and id(node) not in called:
                note(node, "`%s`" % qualified, NEW_QUALIFIED[qualified])
        elif isinstance(node, (ast.BinOp, ast.AugAssign)) and isinstance(node.op, ast.BitOr):
            operands = ((node.left, node.right) if isinstance(node, ast.BinOp)
                        else (node.target, node.value))
            if any(isinstance(op, (ast.Dict, ast.DictComp)) for op in operands):
                note(node, "dict merge with `|` (PEP 584)", "3.9")
        elif isinstance(node, ast.ImportFrom) and node.module and id(node) not in guarded:
            for alias in node.names:
                added = NEW_FROM_IMPORTS.get((node.module, alias.name))
                if added:
                    note(node, "`from %s import %s`" % (node.module, alias.name), added)
            if node.module.split(".")[0] in NEW_MODULES:
                added = NEW_MODULES[node.module.split(".")[0]]
                note(node, "unguarded `from %s import …`" % node.module, added)
        elif isinstance(node, ast.Import) and id(node) not in guarded:
            for alias in node.names:
                root_name = alias.name.split(".")[0]
                if root_name in NEW_MODULES:
                    note(node, "unguarded `import %s`" % alias.name, NEW_MODULES[root_name])
    return out


# ------------------------------------------------------------ the declarations --

def toml_value(text: str, key: str) -> str:
    match = re.search(r"^[ \t]*%s[ \t]*=[ \t]*\"([^\"]*)\"" % re.escape(key), text, re.M)
    return match.group(1) if match else ""


def declaration_problems() -> list[str]:
    """The floor as WRITTEN, in every place it is written.

    The root pyproject is the host's own and is always here. The two component
    pyprojects belong to SUBMODULES: read when the checkout is present (the
    `verify-py38` leg checks them out), noted and skipped when it is not (the
    cheap `verify` job runs in a bare checkout, and a release must not depend on
    a submodule being checked out). Their absence is a smaller scan, not a
    violation — but it is printed, because a gate that quietly narrows itself is
    how a floor rots.
    """
    out: list[str] = []
    for name in PYPROJECTS:
        path = ROOT / name
        if not path.is_file():
            if name == PYPROJECTS[0]:
                out.append("%s is missing" % name)
            else:
                print("note: %s is not checked out (submodule) — its declaration is "
                      "read by the leg that checks the components out" % name)
            continue
        text = path.read_text(encoding="utf-8")
        declares = toml_value(text, "requires-python")
        if declares != REQUIRES_PYTHON:
            out.append('%s declares requires-python = "%s", not "%s"'
                       % (name, declares, REQUIRES_PYTHON))
        lints = toml_value(text, "target-version")
        if lints != RUFF_TARGET:
            out.append('%s lints for %s, not %s: ruff and the declaration disagree'
                       % (name, lints or "no target", RUFF_TARGET))

    tunnel = (ROOT / TUNNEL).read_text(encoding="utf-8")
    found = re.search(r"const PY_FLOOR = \[(\d+), *(\d+)\]", tunnel)
    if not found:
        out.append("%s declares no PY_FLOOR: nothing refuses a remote older than the floor" % TUNNEL)
    elif (int(found.group(1)), int(found.group(2))) != FLOOR:
        out.append("%s refuses remotes below %s.%s, but the floor is %s"
                   % (TUNNEL, found.group(1), found.group(2), FLOOR_VERSION))

    workflow = (ROOT / WORKFLOW).read_text(encoding="utf-8")
    job = job_body(workflow, "verify-py38")
    if job is None:
        out.append("%s has no `verify-py38` job: the floor is declared and never run" % WORKFLOW)
    else:
        if 'python-version: "%s"' % FLOOR_VERSION not in job:
            out.append("`verify-py38` does not pin python-version: \"%s\"" % FLOOR_VERSION)
        if "tests.py38_check" not in job:
            out.append("`verify-py38` does not run this check")
        if "tests.selfcheck" not in job:
            out.append("`verify-py38` does not run the suite on the floor")
        # The full suite needs an installed component (write_file is declared
        # there, not built in), and the components are submodules: a leg that
        # checks none of them out can only run part of the suite, and cannot
        # scan the code a remote will execute either.
        if "submodules: recursive" not in job:
            out.append("`verify-py38` checks out no submodule: without the "
                       "components the suite cannot install anything to write with")
        deb = job_body(workflow, "deb")
        if deb is not None and "verify-py38" not in needs_of(deb):
            out.append("`deb` does not need `verify-py38`: a tree that only runs on "
                       "3.12 still reaches the release")
    return out


def job_body(text: str, name: str) -> str | None:
    """The lines of one job block, or None. A job is a 2-space `name:` line; its
    body is everything up to the next one."""
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.rstrip() == "  %s:" % name:
            start = index + 1
            break
    if start is None:
        return None
    end = len(lines)
    for index in range(start, len(lines)):
        if re.match(r"^  [A-Za-z0-9_-]+:[ \t]*$", lines[index]):
            end = index
            break
    return "\n".join(lines[start:end])


def needs_of(body: str) -> list[str]:
    """The job's `needs:` list, in any of the spellings the file may use."""
    for line in body.splitlines():
        match = re.match(r"^    needs:[ \t]*(.*)$", line)
        if not match:
            continue
        inline = match.group(1).strip()
        if inline.startswith("["):
            return [word.strip().strip("'\"") for word in inline.strip("[]").split(",") if word.strip()]
        return [inline.strip("'\"")] if inline else []
    return []


# ------------------------------------------------------------------- the checks --

def check_syntax() -> None:
    paths = sources()
    check(len(paths) > 100, "the scan found the tree's python (%d files)" % len(paths))
    problems = syntax_problems(paths)
    check(not problems,
          "every shipped source parses as %s%s" % (FLOOR_VERSION,
                                                   "" if not problems else ": " + "; ".join(problems)))


def check_evaluated_annotations() -> None:
    problems: list[str] = []
    for path in sources():
        text, tree = parse(path)
        problems += annotation_problems(tree, rel(path))
    check(not problems,
          "nothing an import evaluates is newer than %s%s"
          % (FLOOR_VERSION, "" if not problems else ": " + "; ".join(problems)))


def check_apis() -> None:
    problems: list[str] = []
    for path in sources():
        text, tree = parse(path)
        problems += api_problems(tree, text, rel(path))
    check(not problems,
          "no API newer than %s is called%s"
          % (FLOOR_VERSION, "" if not problems else ": " + "; ".join(problems)))


def check_declarations() -> None:
    problems = declaration_problems()
    check(not problems,
          "pyproject / PY_FLOOR / verify-py38 all say %s%s"
          % (FLOOR_VERSION, "" if not problems else ": " + "; ".join(problems)))


# ------------------------------------------------------- the scan, on its own --

FIXTURES = (
    # (what the module is called, source, the phrase the complaint must carry)
    ("a PEP 585 alias", "from typing import Callable\nImpl = Callable[[int], dict[str, int]]\n",
     "PEP 585"),
    ("a PEP 604 alias", "Alias = int | None\n", "PEP 604"),
    ("a PEP 604 argument", "def f(x: int | None) -> None:\n    pass\n", "PEP 604"),
    ("Path.write_text(newline=)", "from pathlib import Path\nPath('x').write_text('y', newline='\\n')\n",
     "newline"),
    ("zip(strict=)", "def f(a, b):\n    return list(zip(a, b, strict=True))\n", "strict"),
    ("a dict merge with `|`", "FLAGS = {'a': 1} | make()\n", "PEP 584"),
    ("str.removeprefix", "def f(s):\n    return s.removeprefix('x')\n", "removeprefix"),
    ("sys.stdlib_module_names", "import sys\nNAMES = sys.stdlib_module_names\n", "stdlib_module_names"),
    ("an unguarded tomllib import", "import tomllib\n", "tomllib"),
)

# Syntax the floor cannot parse at all. A newer interpreter has to refuse it BY
# NAME (`feature_version` doing the work); ON the floor it simply does not parse,
# and "invalid syntax" is that interpreter's whole verdict — which is also why
# this module can run there at all.
SYNTAX_FIXTURES = (
    ("a parenthesized `with`", "with (open('a') as a, open('b') as b):\n    pass\n",
     "Parenthesized context managers"),
    ("a match statement", "match 1:\n    case 1:\n        pass\n", "match"),
)


def check_regression() -> None:
    """The scan has to FAIL on the shapes it exists for: a scan that only ever
    sees a good tree proves nothing (and every one of these shipped here once)."""
    for what, source, phrase in SYNTAX_FIXTURES:
        try:
            ast.parse(source, feature_version=FLOOR)
            message = ""
        except SyntaxError as exc:
            message = str(exc.msg)
        at_floor = sys.version_info[:2] <= FLOOR
        check(bool(message) and (at_floor or phrase in message),
              "%s does not parse as %s (%s)"
              % (what, FLOOR_VERSION, message or "accepted"))

    for what, source, phrase in FIXTURES:
        tree = ast.parse(source)
        complaints = annotation_problems(tree, "fixture") + api_problems(tree, source, "fixture")
        check(any(phrase in complaint for complaint in complaints),
              "%s is reported (%s)" % (what, phrase))

    # …and a clean module is not: the floor's own code, guarded fallbacks and all
    clean = (
        "from __future__ import annotations\n"
        "import ast\n"
        "try:\n"
        "    import tomllib\n"
        "except ModuleNotFoundError:\n"
        "    tomllib = None\n"
        "Alias = 'int | None'\n"        # a string is not an annotation
        "FLAGS = 1 | 2\n"               # integer arithmetic is not a dict merge
        "NAMES = FLAGS | 4\n"           # …nor is a mask of constants
        "def f(x: dict[str, int] | None) -> list[str]:\n"
        "    return [str(os_walk) for os_walk in ast.walk(x)]\n"
    )
    complaints = annotation_problems(ast.parse(clean), "fixture") + api_problems(
        ast.parse(clean), clean, "fixture")
    check(not complaints, "a 3.8-clean module is not reported%s"
          % ("" if not complaints else ": " + "; ".join(complaints)))


    # the declarations are read, not assumed: a floor raised in one file is caught
    raised = (ROOT / PYPROJECTS[0]).read_text(encoding="utf-8").replace(
        'requires-python = "%s"' % REQUIRES_PYTHON, 'requires-python = ">=3.9"')
    check(toml_value(raised, "requires-python") == ">=3.9",
          "a pyproject that raises the floor is readable")
    check(toml_value((ROOT / PYPROJECTS[0]).read_text(encoding="utf-8"),
                     "requires-python") == REQUIRES_PYTHON,
          "the shipped pyproject declares %s" % REQUIRES_PYTHON)


def main() -> int:
    print("what the floor has to cover:")
    check_syntax()
    print("what an import evaluates:")
    check_evaluated_annotations()
    print("what only runs later:")
    check_apis()
    print("where the floor is written down:")
    check_declarations()
    print("the scan itself:")
    check_regression()

    if failures:
        print("\npy38_check: %d FAILED" % len(failures))
        return 1
    print("\npy38_check: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
