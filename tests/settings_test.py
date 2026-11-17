"""A component's settings: the form the host draws from a declaration.

Run: .venv/bin/python -m tests.settings_test

The host knows no setting of any component — the way an editor knows no setting
of any extension. A declaration contributes a `settings` block (one entry per
knob: `type`, `default`, `description`), and the host does exactly three things
with it:

  * SERVES it as data beside the current values (`GET /api/components/settings`),
    so the form is drawn from the declaration that will read the answer;
  * KEEPS one document per component, holding the EFFECTIVE values — defaults
    included — under the components root, written whole and atomically;
  * HANDS it to the component through the interface it already has for host
    facts: a `vars` entry naming `host.settings` puts the document's path where
    the declaration says `{settings}`, so a component needs no new wire format.

A write is PARTIAL (the form sends the knob a person touched) and a key or value
the declaration does not carry is refused, never dropped: the caller believed
something false about the component.

Isolation: CLUTCH_COMPONENTS_DIR and CLUTCH_COMPONENTS_CATALOG point at a temp
tree, and modules.repo_root is repointed, so this run never reads or writes the
components installed for the user running it.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import threading
from collections.abc import Iterator, Mapping
from pathlib import Path

from agent.config import Config
from agent.supervisor import Supervisor, build_server
from agent.tools import catalog, components, modules, settings, statement
from tests.testsupport import check, http_get, http_post

DECLARED = {
    "library.enabled": {
        "type": "boolean",
        "default": True,
        "description": "offer the library at all",
    },
    "library.root": {
        "type": "string",
        "default": "",
        "description": "the directory to serve instead",
    },
    "library.order": {
        "type": "enum",
        "enum": ["name", "recent"],
        "default": "name",
        "description": "how the catalog is sorted",
    },
}
DEFAULTS = {"library.enabled": True, "library.root": "", "library.order": "name"}


def _declaration(name: str) -> dict:
    """One component that carries a form and no process: what a component whose
    whole contribution is a prompt and its settings looks like."""
    return {
        "name": name,
        "vars": {"settings": "host.settings"},
        "settings": dict(DECLARED),
    }


@contextlib.contextmanager
def isolated_host(declarations: Mapping[str, dict]) -> Iterator[Path]:
    """A host of one's own: temp install root and catalog, no checkouts."""
    with tempfile.TemporaryDirectory() as root:
        base = Path(root) / "repo"
        base.mkdir()
        saved = (
            os.environ.get(components.ROOT_ENV),
            os.environ.get("CLUTCH_COMPONENTS_CATALOG"),
            modules.repo_root,
        )
        os.environ[components.ROOT_ENV] = root
        os.environ["CLUTCH_COMPONENTS_CATALOG"] = str(Path(root) / "catalog.d")
        modules.repo_root = lambda: base  # type: ignore[method-assign]
        directory = catalog.catalog_dir()
        directory.mkdir(parents=True, exist_ok=True)
        for name, data in declarations.items():
            (directory / f"{name}.json").write_text(json.dumps(data), encoding="utf-8")
        try:
            yield Path(root)
        finally:
            modules.repo_root = saved[2]  # type: ignore[method-assign]
            for key, previous in ((components.ROOT_ENV, saved[0]), ("CLUTCH_COMPONENTS_CATALOG", saved[1])):
                if previous is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous


def _stored(root: Path, name: str) -> dict:
    """What the components root holds for one component, read as JSON."""
    return json.loads((root / "settings" / f"{name}.json").read_text(encoding="utf-8"))


def _routes(base: str, name: str) -> None:
    """The two settings routes, exercised over a real socket."""

    def get() -> tuple[int, dict]:
        st, body = http_get(f"{base}/api/components/settings?name={name}")
        return st, json.loads(body)

    def post(values: object) -> tuple[int, dict]:
        st, body = http_post(f"{base}/api/components/settings", {"name": name, "values": values})
        return st, json.loads(body)

    st, answered = get()
    check(st == 200, "GET /api/components/settings answers at all")
    check(answered["schema"] == DECLARED, "with the DECLARATION's form, unchanged")
    check(answered["values"] == DEFAULTS, "beside where every knob currently stands")

    st, answered = post({"library.order": "recent"})
    check(
        st == 200 and answered == {"status": "saved", "values": DEFAULTS | {"library.order": "recent"}},
        "POST saves the one knob it was sent and answers the whole document back",
    )
    check(get()[1]["values"]["library.order"] == "recent", "and the next GET reads it")

    st, answered = post({"library.nope": 1})
    check(st == 400 and "declares no setting 'library.nope'" in answered["error"], "a key the declaration does not carry is refused")
    st, answered = post({"library.order": "sideways"})
    check(st == 400 and "is not a enum" in answered["error"], "and so is a value of the wrong type")
    st, answered = post([])
    check(st == 400 and "values must be an object" in answered["error"], "a body that is not a settings object is refused")

    st, answered = http_get(f"{base}/api/components/settings")
    check(st == 400 and "name is required" in json.loads(answered)["error"], "a read that names no component is a usage error")
    st, body = http_post(f"{base}/api/components/settings", {"name": "clutch-nothing", "values": {}})
    check(st == 404 and "no component named" in json.loads(body)["error"], "and a component this host does not hold is not found")


def main() -> int:
    with isolated_host({"clutch-form": _declaration("clutch-form")}) as root:
        component = catalog.table()["clutch-form"]

        # -- the schema: what the host will draw, checked before it is drawn ---
        check(catalog.settings_diagnostics(component) == [], "a declaration the form can draw is refused by nothing")
        bad = catalog.Component(
            name="clutch-bad",
            settings={
                "no_default": {"type": "string", "description": "says nothing useful"},
                "NotAName": {"type": "string", "default": "", "description": "dotted words only"},
                "wrong": {"type": "boolean", "default": "yes", "description": "a string is not a boolean"},
            },
        )
        said = " | ".join(d.message for d in catalog.settings_diagnostics(bad))
        check(
            "declares no default" in said and "is not a name" in said and "not a boolean" in said,
            "a knob the form could not draw is refused instead of drawn as a plain box",
        )

        # -- the store: one effective document per component -------------------
        check(settings.values("clutch-form", component) == DEFAULTS, "an unconfigured component reads back its own defaults")
        check(not (root / "settings").exists(), "...and nothing was written to say so")
        saved = settings.write("clutch-form", component, {"library.root": "~/my-library"})
        check(saved == DEFAULTS | {"library.root": "~/my-library"}, "a partial write keeps the knobs it did not name")
        check(_stored(root, "clutch-form") == saved, "the file holds the EFFECTIVE document, defaults included")
        mode = (root / "settings" / "clutch-form.json").stat().st_mode & 0o777
        check(oct(mode) == "0o600", "and only its owner can read it")

        # an older version's value, and a key no longer declared: neither is an
        # error and neither is a value — the default stands in, so an upgrade is
        # not a trap.
        (root / "settings" / "clutch-form.json").write_text(
            json.dumps({"library.order": "sideways", "gone": 1}), encoding="utf-8"
        )
        check(settings.values("clutch-form", component) == DEFAULTS, "a value that no longer fits its declaration is not a value")

        # -- the delivery: the interface the component ALREADY has -------------
        ready = statement.host_vars(component, Config())
        check(set(ready) == {"settings"}, "`vars: {settings: host.settings}` fills that one host value and no other")
        document = json.loads(Path(ready["settings"]).read_text(encoding="utf-8"))
        check(
            Path(ready["settings"]) == settings.path("clutch-form") and document == DEFAULTS,
            "and its value is the path of a document that EXISTS, holding the effective values",
        )
        quiet = catalog.Component(name="clutch-quiet")
        check(statement.host_vars(quiet, Config()) == {}, "a component that declares no settings never sees the placeholder")

        # -- the routes: the same store, over the supervisor's own socket ------
        sup = Supervisor(
            agent_cmd=[sys.executable, "-m", "agent.server"],
            cwd=str(Path(__file__).resolve().parents[1]),
            reap_interval_s=0.2,
        )
        srv = build_server(0, sup)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            _routes(f"http://127.0.0.1:{srv.server_address[1]}", "clutch-form")
        finally:
            srv.shutdown()
            sup.shutdown_all()

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
