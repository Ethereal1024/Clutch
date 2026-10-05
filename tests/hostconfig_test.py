"""The host's own document: ~/.clutch/host.json (or CLUTCH_HOST_CONFIG).

Run: .venv/bin/python -m tests.hostconfig_test

The host's tables — which `access` words exist and what enforces each, which
named `gate` conditions it can stand behind, what a tool's events look like when
its `ui` block says nothing, which search backends this machine's config can
switch on — used to live only in tools/catalog.py's source. tools/hostconfig.py
lets ONE document name them, under the same rules the declarations got:

  * the constants stay, as the DEFAULTS; a section the document names is merged
    over them word by word ("点名即覆盖"), a word named `null` stops existing,
    and the chain (`backends`) is replaced whole — a list has no key to merge on;
  * the document chooses among implementations the host ALREADY has and never
    brings one: a word whose guard/condition the host cannot name is not
    created, and does not take a built-in word down with it (fail closed);
  * everything unreadable is said out loud once (`said()`), and a document
    unreadable as a WHOLE is ignored as a whole.

This suite pins those rules with explicit documents (`doc=`), then drives the
real path — env var, real file, forget() — and finally a subprocess whose
catalog/registry/permission are BUILT from a document, since the merges run at
import and cannot be re-run inside this process.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from agent.tools import catalog, hostconfig
from tests.testsupport import check


@contextlib.contextmanager
def quiet():
    """Swallow the [host] log lines a complaint prints, and hand them back."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        yield buf


@contextlib.contextmanager
def mute_log():
    """Silence the [host] log line itself: said() still records the complaint."""
    from agent.procmgr import stdio

    saved = stdio.log
    stdio.log = lambda msg: None
    try:
        yield
    finally:
        stdio.log = saved


def with_env(value: str | None):
    """Set CLUTCH_HOST_CONFIG for a block (None = unset), restoring after."""
    saved = os.environ.get("CLUTCH_HOST_CONFIG")

    class _Ctx:
        def __enter__(self):
            if value is None:
                os.environ.pop("CLUTCH_HOST_CONFIG", None)
            else:
                os.environ["CLUTCH_HOST_CONFIG"] = value
            hostconfig.forget()

        def __exit__(self, *exc):
            if saved is None:
                os.environ.pop("CLUTCH_HOST_CONFIG", None)
            else:
                os.environ["CLUTCH_HOST_CONFIG"] = saved
            hostconfig.forget()

    return _Ctx()


# ---------------------------------------------------------------- path() ----


def check_path() -> None:
    check(hostconfig.path() == Path.home() / ".clutch" / "host.json", "no env: the document is ~/.clutch/host.json")
    with with_env(""):
        check(hostconfig.path() is None, "blank env is a decision: no document, not the default one")
    with with_env("   "):
        check(hostconfig.path() is None, "a blank-ish env is blank, not a filename of spaces")
    with with_env("~/somewhere/host.json"):
        check(hostconfig.path() == Path.home() / "somewhere" / "host.json", "a named file wins and ~ expands")


# ------------------------------------------------- document(): a real file ----


def check_document(tmp: Path) -> None:
    at = tmp / "host.json"

    with with_env(str(tmp / "missing.json")):
        with quiet():
            doc = hostconfig.document()
        check(doc == {}, "an absent document reads as empty")
        check(hostconfig.said() == (), "and absence says nothing: it is the normal state")

    at.write_text("{oops", encoding="utf-8")
    with with_env(str(at)):
        with quiet() as buf:
            doc = hostconfig.document()
        check(doc == {}, "a document that is not JSON is ignored as a whole")
        said = hostconfig.said()
        check(len(said) == 1 and "JSON" in said[0], f"the whole-file failure is said once: {said}")
        check("[host]" in buf.getvalue() and "host.json" in buf.getvalue(), "the complaint went to the log too")
        hostconfig.forget()
        check(hostconfig.said() == (), "forget() clears what was said, to read again")

    at.write_text('["a list"]', encoding="utf-8")
    with with_env(str(at)):
        with quiet():
            doc = hostconfig.document()
        check(doc == {}, "a JSON value that is not an object is ignored as a whole")
        said = hostconfig.said()
        check(len(said) == 1 and "not a JSON object" in said[0], "the not-an-object complaint is said")

    at.write_text('{"ui": {"chip": "path"}}', encoding="utf-8")
    with with_env(str(at)):
        with quiet():
            doc = hostconfig.document()
        check(doc.get("ui") == {"chip": "path"}, "a readable document is returned as read")
        check(hostconfig.said() == (), "and a readable document says nothing")


# ----------------------------------------------------- access: the words ----


def check_access_merges() -> None:
    built_in = dict(catalog.DEFAULT_ACCESS)
    guards = catalog.GUARD_IMPLS

    hostconfig.forget()
    merged = hostconfig.access(built_in, guards, doc={})
    check(merged == built_in, "no access section: the built-in words stand, whole")

    doc = {"access": {"read": {"arg": "file"}}}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check(merged["read"] == hostconfig.AccessWord("guard_read", "file"), "a named field overrides, unnamed fields keep")
    check(merged["sweep"] == built_in["sweep"], "a word the section does not name is untouched")
    check(hostconfig.said() == (), "a readable override says nothing")

    doc = {"access": {"mode": {"guard": "guard_write", "arg": "dir"}}}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check(merged["mode"] == hostconfig.AccessWord("guard_write", "dir"), "a new word may reuse a guard the host has")
    check(set(merged) - set(built_in) == {"mode"}, "the new word is the only addition")

    doc = {"access": {"mode": {"guard": "guard_etc", "arg": "dir"}}}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check("mode" not in merged, "a word whose guard the host has not got is not created")
    check("guard_etc" in hostconfig.said()[0], "and the unknown guard is named in what was said")

    doc = {"access": {"read": {"guard": "guard_etc", "arg": "path"}}}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check(merged["read"] == built_in["read"], "a bad guard on a BUILT-IN word leaves the built-in word standing")

    doc = {"access": {"sweep": None}}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check("sweep" not in merged and "read" in merged, "a word named null stops existing; the rest keep")

    doc = {"access": {"read": 5}}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check(merged == built_in, "an entry that is not an object leaves the built-in word")
    check("'read'" in hostconfig.said()[-1], "and the unreadable entry is said")

    doc = {"access": {"mode": {"guard": "guard_write"}}}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check("mode" not in merged, "a new word that names no argument for its guard is not offered")
    check("no argument" in hostconfig.said()[-1], "the missing-argument complaint is said")

    doc = {"access": {"mode": {"guard": "", "arg": "cmd"}}}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check(merged["mode"] == hostconfig.AccessWord("", "cmd"), '"" guard: the word exists, the host applies nothing')

    doc = {"access": {"read": {"guard": 7, "arg": "path"}}}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check(merged["read"] == built_in["read"], "a guard that is not a string leaves the built-in word")

    doc = {"access": ["read"]}
    merged = hostconfig.access(built_in, guards, doc=doc)
    check(merged == built_in, "a section that is not an object leaves the built-in table whole")
    check("access" in hostconfig.said()[-1], "and the unreadable section is said")


# ------------------------------------------------------ gates: conditions ----


def check_gate_merges() -> None:
    built_in = dict(catalog.DEFAULT_GATES)
    impls = catalog.GATE_IMPLS

    hostconfig.forget()
    merged = hostconfig.gates(built_in, impls, doc={})
    check(merged == built_in, "no gates section: the built-in conditions stand")

    doc = {"gates": {"cachedir": "project"}}
    merged = hostconfig.gates(built_in, impls, doc=doc)
    check(merged["cachedir"] == "project" and merged["skills"] == "skills",
          "a new gate word maps to a condition the host has")

    doc = {"gates": {"cachedir": "etc"}}
    merged = hostconfig.gates(built_in, impls, doc=doc)
    check("cachedir" not in merged, "a condition the host has not got is not offered")
    check("'etc'" in hostconfig.said()[0], "and the unknown condition is said")

    doc = {"gates": {"skills": "etc"}}
    merged = hostconfig.gates(built_in, impls, doc=doc)
    check(merged["skills"] == "skills", "a bad condition on a built-in gate leaves it standing")

    doc = {"gates": {"skills": None}}
    merged = hostconfig.gates(built_in, impls, doc=doc)
    check("skills" not in merged and "project" in merged, "a gate named null stops existing")

    doc = {"gates": {"": "project", "x": 5}}
    before = len(hostconfig.said())
    merged = hostconfig.gates(built_in, impls, doc=doc)
    check(merged == built_in, "a wordless name and a non-string condition are both refused")
    check(
        len(hostconfig.said()) - before == 2,
        f"each refusal is said on its own ({len(hostconfig.said()) - before} complaints)",
    )


# ----------------------------------------------------------- ui: the look ----


def check_ui_merges() -> None:
    built_in = dict(catalog.DEFAULT_UI)

    hostconfig.forget()
    merged = hostconfig.ui(built_in, doc={})
    check(merged == built_in, "no ui section: the built-in look stands")

    doc = {"ui": {"chip": "none", "group": None, "custom": {"deep": [1, 2]}}}
    merged = hostconfig.ui(built_in, doc=doc)
    check(merged["chip"] == "none", "a named key overrides the built-in value")
    check(merged["group"] is None, "null is a VALUE here (group means ungrouped), not a removal")
    check(merged["custom"] == {"deep": [1, 2]}, "unknown keys are kept as data: the renderer ignores them")
    check(merged["form"] == built_in["form"], "keys the section does not name keep the built-in")
    check(hostconfig.said() == (), "a ui table is data: nothing in it is refused or complained about")

    doc = {"ui": None}
    merged = hostconfig.ui(built_in, doc=doc)
    check(merged == built_in, 'a null section is an empty table: the built-in stands')

    doc = {"ui": ["chip"]}
    merged = hostconfig.ui(built_in, doc=doc)
    check(merged == built_in, "a section that is not an object leaves the built-in look")
    check("ui" in hostconfig.said()[-1], "and the unreadable section is said")


# ----------------------------------------------------- backends: the chain ----


def check_backend_merges() -> None:
    built_in = catalog.DEFAULT_BACKENDS
    fields = catalog.BACKEND_FIELDS

    hostconfig.forget()
    merged = hostconfig.backends(built_in, fields, doc={})
    check(merged == built_in, "no backends section: the built-in chain stands")

    doc = {"backends": [{"name": "ddg", "field": ""}, {"name": "tavily", "field": "tavily_api_key"}]}
    with quiet():
        merged = hostconfig.backends(built_in, fields, doc=doc)
    check(merged == (hostconfig.Backend("ddg", ""), hostconfig.Backend("tavily", "tavily_api_key")),
          "a chain is replaced WHOLE, in the order written")
    check(hostconfig.said() == (), "a readable chain says nothing")

    doc = {"backends": [{"name": "tavily", "field": "tavily_api_key"}, {"name": "ghost", "field": "no_such_field"}]}
    with quiet():
        merged = hostconfig.backends(built_in, fields, doc=doc)
    check(merged == (hostconfig.Backend("tavily", "tavily_api_key"),),
          "an entry no config field can switch on is dropped")
    check("ghost" in hostconfig.said()[-1], "and the dropped entry is said")

    doc = {"backends": [{"name": "x", "field": None}, {"field": ""}, "ddg", {"name": ""}]}
    before = len(hostconfig.said())
    with quiet():
        merged = hostconfig.backends(built_in, fields, doc=doc)
    check(merged == (hostconfig.Backend("x", ""),),
          "null field is unconfigured; nameless and empty entries are dropped")
    check(
        len(hostconfig.said()) - before == 3,
        f"each dropped entry is said on its own ({len(hostconfig.said()) - before} complaints)",
    )

    doc = {"backends": {"name": "ddg"}}
    with quiet():
        merged = hostconfig.backends(built_in, fields, doc=doc)
    check(merged == built_in, "a chain that is not a list leaves the built-in chain standing")

    with quiet():
        merged = hostconfig.backends(catalog.DEFAULT_BACKENDS, fields, doc={"backends": [{"name": "ddg"}]})
    check(merged == (hostconfig.Backend("ddg", ""),),
          "field defaults to the empty string: a backend that needs no config")


# ------------------------------------------- the whole import path, for real ----

DOC = """{
  "access": {"read": {"arg": "file"}, "mode": {"guard": "guard_write", "arg": "dir"}},
  "gates": {"cachedir": "project", "skills": null},
  "ui": {"chip": "none", "group": "host"},
  "backends": [{"name": "tavily", "field": "tavily_api_key"},
               {"name": "ghost", "field": "no_such_field"}]
}"""

SUBCODE = """
import json
from agent.tools import catalog, filesystem, registry
from agent.core import permission
from agent.config import Config
config = Config()
sentinel = object()
print(json.dumps({
    "access_args": catalog.ACCESS_ARGS,
    "gates": list(catalog.GATES),
    "gate_words": catalog.GATE_WORDS,
    "chip": catalog.DEFAULTS.get("chip"),
    "group": catalog.DEFAULTS.get("group"),
    "backends": [list(b) for b in catalog._BACKENDS],
    "read_guard_bound": registry.ACCESS["read"].guard is filesystem.guard_read,
    "read_arg": registry.ACCESS["read"].arg,
    "mode_guard_bound": (
        registry.ACCESS["mode"].guard is filesystem.guard_write if "mode" in registry.ACCESS else False
    ),
    "cachedir_open": registry._gate_ok("cachedir", config, sentinel),
    "skills_shut": registry._gate_ok("skills", config, sentinel),
    "stranger_shut": registry._gate_ok("no_such_gate", config, sentinel),
    "guarded_arg_read": permission.GUARDED_ARG.get("read"),
}))
"""


def check_subprocess(tmp: Path) -> None:
    """The merges run at IMPORT: the only honest way to test the real path is a
    process whose catalog is built from a document that exists on disk."""
    at = tmp / "host.json"
    at.write_text(DOC, encoding="utf-8")

    for env_value, expect_defaults in ((str(at), False), ("", True)):
        env = dict(os.environ, CLUTCH_HOST_CONFIG=env_value)
        proc = subprocess.run(
            [sys.executable, "-c", SUBCODE], env=env, capture_output=True, text=True, timeout=120, check=True
        )
        # the tag, not the line start: procmgr/stdio.py stamps every log line with
        # a wall clock (see _stamp), so the tag is never the first thing on it —
        # the in-process assertion above already matches it this way
        said_lines = [ln for ln in proc.stdout.splitlines() if "[host]" in ln]
        data = json.loads(proc.stdout.splitlines()[-1])
        if expect_defaults:
            check(data["access_args"] == catalog.ACCESS_ARGS, "no document: the built-in words are the vocabulary")
            check(data["gates"] == list(catalog.GATES), "no document: the built-in gates are the vocabulary")
            check(data["chip"] == catalog.DEFAULTS.get("chip"), "no document: the built-in look stands")
            check(data["backends"] == [list(b) for b in catalog._BACKENDS], "no document: the built-in chain stands")
            continue
        check(
            data["access_args"]
            == {"read": "file", "sweep": "path", "write": "path", "command": "command", "mode": "dir"},
            "the document renames read's argument and teaches a new word",
        )
        check(data["read_guard_bound"] and data["mode_guard_bound"],
              "the taught words bind to the guards the host already had")
        check(data["gates"] == ["", "always", "project", "cachedir"],
              "the gate table gains a word and loses `skills` (named null)")
        check(data["cachedir_open"] is True, "the taught gate word answers with the condition it named")
        check(data["skills_shut"] is False, "the removed gate word shuts: an unknown word is never always-true")
        check(data["stranger_shut"] is False, "a gate word nobody taught the host shuts too")
        check(data["chip"] == "none" and data["group"] == "host", "the ui table reaches catalog.DEFAULTS as written")
        check(data["backends"] == [["tavily", "tavily_api_key"]], "the chain was replaced whole; the ghost was dropped")
        check(data["guarded_arg_read"] == "file", "the permission engine judges by the renamed argument")
        check(any("ghost" in ln for ln in said_lines), "the dropped backend was said out loud in the log")


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        check_path()
        check_document(tmp)
        with mute_log():  # the merges below say their complaints into said(), not stdout
            check_access_merges()
            check_gate_merges()
            check_ui_merges()
            check_backend_merges()
        check_subprocess(tmp)
    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
