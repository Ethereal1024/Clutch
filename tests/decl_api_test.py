"""GET /api/declarations: the data the HOST derives the tool surface from (P3-1).

Run: .venv/bin/python -m tests.decl_api_test

The derivation moved to the frontend (TODO.md D1/P3-1, `ui/tool-decl.js`), so
what is left here is data — and this suite pins that it really is data. What it
checks:

  1. The files, verbatim, in merge order: `declarations` is `catalog.registrations()`
     itself, so a `$config` token is still a token and no derived field (`schema`,
     `mutates`, a resolved description) has crept in. A second reading here is the
     bug the frontend is removing.
  2. The machine's answers beside them: which components this host can drive,
     the backends it is configured for, the published facts already answered, and
     the `ui`/`access`/`gate` tables — all equal to the tables the host really
     holds, not to a copy written out again.
  3. `config` is NARROW: only fields the loaded declarations actually name, only
     numbers and bools. A credential is a string, so a manifest cannot name its
     way to one; an unnamed knob is not served even when it is a number.
  4. No project is not an error: the page needs a surface before it can open one,
     so this endpoint answers 200 with `project: false` (unlike the writers, 409).
  5. It writes nothing: the .clc is byte-identical after the call.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
from pathlib import Path

from agent.api import decls
from agent.base import Broadcaster, RunState
from agent.config import Config
from agent.project import create_project
from agent.server import build
from agent.tools import answers, catalog
from tests.testsupport import check, http_get

SECRET = "sk-decl-test-SECRET-not-in-the-surface"


def open_server(tmp: Path, name: str, **cfg_fields):
    """A real server (routing + handler wiring), with NO project open."""
    path = tmp / name / f"{name}.clc"
    path.parent.mkdir(parents=True, exist_ok=True)
    project = create_project(path, name, model="fake-model")
    cfg = Config(host="127.0.0.1", port=0, **cfg_fields)
    state = RunState()
    srv = build(cfg, Broadcaster(), state)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{cfg.port}", cfg, state, project, srv


def surface(base: str) -> tuple[int, dict, str]:
    status, text = http_get(f"{base}/api/declarations")
    try:
        return status, json.loads(text), text
    except json.JSONDecodeError:  # pragma: no cover - a non-JSON answer is a bug
        check(False, f"/api/declarations answers JSON (got {status}: {text[:200]})")
        raise


# ---- 1. the files themselves ----------------------------------------------------


def files_check(tmp: Path) -> None:
    base, cfg, state, _project, srv = open_server(tmp, "files")
    status, body, _text = surface(base)
    check(status == 200, "no project open is answered 200, not 409 (the page needs a surface first)")
    check(
        sorted(body) == ["available", "backends", "config", "declarations", "facts", "host", "mode", "project"],
        "the answer carries exactly the eight facts the reading needs",
    )
    check(
        body["declarations"] == catalog.registrations(),
        "declarations are catalog.registrations() itself, in merge order",
    )
    check(
        body["declarations"] == json.loads(json.dumps(catalog.registrations())),
        "declarations survive the wire unchanged (JSON round trip is a no-op)",
    )
    names = [d.get("name") for d in body["declarations"]]
    check("clutch-workspace" in names, "the checkout manifests this repo ships are in the list")
    check(len(names) >= 5, f"every registration is here, not one per component ({len(names)} entries)")
    by_name = {}
    for d in body["declarations"]:
        by_name.setdefault(d.get("name"), []).append(d)
    raw = by_name["clutch-workspace"][0]
    check("schema" not in raw and "mutates" not in raw, "no DERIVED field is served: the reading is not made twice")
    tool = next(t for t in raw["tools"] if t["name"] == "read_file")
    check(
        "$config.read_max_chars" in tool["description"],
        "a description is served as written: `$config.<field>` is still a token, never resolved here",
    )
    check(
        tool["parameters"]["properties"].get("max_chars", {}).get("description", "").find("$config.") >= 0,
        "the schema's own prose keeps its tokens too",
    )
    check(
        body["declarations"][0].get("name") == catalog.registrations()[0].get("name"),
        "the first registration is first",
    )
    srv.shutdown()


# ---- 2. what only this machine knows --------------------------------------------


def machine_check(tmp: Path) -> None:
    base, cfg, _state, _project, srv = open_server(tmp, "machine")
    _status, body, _text = surface(base)
    table = catalog.table()
    check(set(body["available"]) == set(table), "available is keyed by exactly the components this host holds")
    check(all(isinstance(v, bool) for v in body["available"].values()), "each availability answer is a bool")
    check(
        body["available"].get("clutch-ssh-workspace") is False,
        "a client-side component with no channel is answered false (fail closed, not missing)",
    )
    check(body["backends"] == list(catalog.available_backends(cfg)), "backends are the configured chain, in order")
    check("tavily" not in body["backends"], "a backend whose key is unset does not exist here")
    check(
        body["facts"] == {token: list(answers._names(token, cfg)) for token in catalog.FACT_TOKENS},
        "facts are answered here, not by the page",
    )
    check(isinstance(body["facts"].get("skills"), list), "the skills fact is published as a list of names")
    check(all(isinstance(n, str) for n in body["facts"]["skills"]), "each skill name is a string")
    host = body["host"]
    check(host["ui"] == catalog.DEFAULTS, "host.ui is the machine's table (document over built-ins)")
    check(
        host["access"] == {word: {"arg": rec.arg} for word, rec in catalog.ACCESS_WORDS.items()},
        "host.access carries the word -> argument table, and nothing of the policy",
    )
    check(host["gates"] == dict(catalog.GATE_WORDS), "host.gates is the named conditions this host has")
    check(body["mode"] == cfg.mode == "work", "mode is the session's own")
    check(body["project"] is False, "no project open -> the `project` gate is closed, as a value")
    srv.shutdown()


# ---- 3. config: named, numeric, never a credential ------------------------------


def config_check(tmp: Path) -> None:
    base, cfg, state, project, srv = open_server(tmp, "config", api_key=SECRET)
    _status, body, text = surface(base)
    check("read_max_chars" in body["config"], "a knob the declarations name is served (read_max_chars)")
    check(body["config"]["read_max_chars"] == cfg.read_max_chars, "and served as the value this host really holds")
    check(
        all(isinstance(v, (bool, int, float)) for v in body["config"].values()),
        "every served knob is a number or a bool, never text",
    )
    check("api_key" not in body["config"], "a credential is never in `config`, even though this host holds one")
    check(SECRET not in text, "the credential's value appears nowhere in the answer")
    check("tavily_api_key" not in body["config"] and "searxng_url" not in body["config"], "string knobs stay here")
    for unnamed in ("port", "host", "llm_read_timeout", "llm_max_retries", "model", "base_url"):
        check(unnamed not in body["config"], f"an UNNAMED knob is not served ({unnamed})")

    # the rule itself, without a manifest: naming a string field is not enough
    named = decls._config(
        Config(api_key=SECRET, model="m"),
        [{"description": "$config.api_key"}, {"description": "default $config.model"}],
    )
    check(named == {}, f"naming a string field serves nothing ({named!r})")
    named = decls._config(Config(port=4321), [{"d": "$config.port"}])
    check(named == {"port": 4321}, "naming a numeric field serves it, in a sentence or as a whole value")
    named = decls._config(
        Config(read_max_chars=99, llm_max_retries=3),
        [{"d": "$config.read_max_chars $config.llm_max_retries"}],
    )
    check(
        named == {"llm_max_retries": 3, "read_max_chars": 99},
        "naming several numeric fields in one sentence serves each",
    )
    named = decls._config(Config(), [{"d": "$config.no_such_field"}])
    check(named == {}, "a field this Config does not have is not read off it")

    state.set_project(project)
    before = project.path.read_bytes()
    _status, body, _text = surface(base)
    check(body["project"] is True, "a project open -> the `project` gate opens")
    check(project.path.read_bytes() == before, "the endpoint writes nothing to the .clc")
    srv.shutdown()


# ---- 4. the session's own shape -------------------------------------------------


def session_check(tmp: Path) -> None:
    base, _cfg, _state, _project, srv = open_server(tmp, "chat", mode="chat")
    _status, body, _text = surface(base)
    check(body["mode"] == "chat", "a chat-mode session reports chat")
    srv.shutdown()

    base, _cfg, _state, _project, srv = open_server(tmp, "route")
    status, text = http_get(f"{base}/api/declaration")
    check(status == 404, "a misspelled path is still 404 (the route table is exact)")
    check(json.loads(text) == {"error": "not found"}, "and says so in the API's one shape")
    srv.shutdown()


def main() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        files_check(tmp)
        machine_check(tmp)
        config_check(tmp)
        session_check(tmp)
    print("decl_api: ok")


if __name__ == "__main__":
    try:
        main()
    except AssertionError:
        sys.exit(1)
