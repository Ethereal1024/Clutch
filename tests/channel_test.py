"""The client's channel: pushed declarations, the one door they open, the call.

Run: .venv/bin/python -m tests.channel_test

A component whose process lives on the CLIENT (interface `plugin`, `runs_on:
other`) is not installable here: its bytes, its keys and its network belong to the
app the user is looking at. What reaches this session is a DECLARATION plus the
coordinates to call it — a loopback port the client's reverse forward listens on
and a bearer token. This suite pins the four things that make that safe and
useful:

  * a push is the WHOLE set and it REPLACES (the client is the source of truth
    for what the client runs), it is refused all-or-nothing with a sentence, and
    it never touches the disk — the install root is the machine's table of
    artifacts and a channel declaration is not one;
  * arrival is visible to the memoized table through the channel's generation, so
    a push is picked up exactly like a manifest that appeared (no invalidate);
  * the door in rendezvous.unavailable_reason opens for a component the live
    channel holds and for NOTHING else — a `runs_on: other` declaration nobody
    implements is still "no channel", never a quiet local run;
  * a call goes over the channel and its answer is the envelope: the component,
    the tool and the model's arguments reach the client, the token rides along,
    and a failure the plugin reports is a failure the model sees.

Isolation: the fixture is catalog_test's isolated_host — a temp install root, a
temp catalog directory and a temp repo root — so the run never sees the user's
components, and the fake client listener is a real loopback HTTP server, because
the point of the channel is the socket, not the shape of a patched urlopen.

The endpoint is exercised through agent.server's own handler (POST / GET / DELETE
/api/channel), which is also how the CORS preflight is pinned: DELETE had to be
admitted to it for "nothing is declared" to be reachable from the window.
"""

from __future__ import annotations

import json
import socket
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agent.base import Broadcaster, RunState
from agent.config import Config
from agent.server import build
from agent.tools import catalog, channel, rendezvous
from agent.tools.registry import ToolRegistry, build_tools, module_blocked_reason
from agent.tools.workspace import LocalWorkspace, RemoteWorkspace
from tests.catalog_test import _third_party, _write_registration, isolated_host
from tests.testsupport import check, http_get

TOKEN = "channel-token-4f2a9c0d7e"  # a push's token: >= 16 chars, no spaces


# --------------------------------------------------------------- the client ---


class Client:
    """The client's own listener, as this session sees it.

    A loopback HTTP server that answers `{content, error?}` and remembers every
    request it got, so a check can read what actually crossed the channel. The
    token check is real: an answer without the right bearer is a 401, which is what
    makes "the token rides along" a fact rather than a spelling.
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.answer: dict = {"content": "ok"}
        self.status = 200
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 -- BaseHTTPRequestHandler's name
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.calls.append(
                    {
                        "path": self.path,
                        "auth": self.headers.get("Authorization", ""),
                        "body": json.loads(raw or b"{}"),
                    }
                )
                if self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
                    outer.calls[-1]["auth"] = "REFUSED"
                    self._answer({"error": "bad token"}, 401)
                    return
                self._answer(outer.answer, outer.status)

            def _answer(self, body: dict, status: int) -> None:
                data = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args) -> None:  # silence the request log
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def _plugin(name: str = "clutch-probe", tool: str = "probe_search", **extra) -> dict:
    """A declaration the way the client writes one: no launch, no command — the
    implementation is its own code, behind the channel."""
    declaration = {
        "name": name,
        "interface": "plugin",
        "runs_on": "other",
        "subject": "network",
        "tools": [
            {
                "name": tool,
                "description": "search the web from the client's own network",
                "parameters": {"properties": {"q": {"type": "string"}}, "required": ["q"]},
            }
        ],
    }
    declaration.update(extra)
    return declaration


def _push(client: Client, *components: dict, token: str = TOKEN) -> channel.Channel:
    return channel.register({"port": client.port, "token": token, "components": list(components)})


def _refused(payload, needle: str, what: str) -> None:
    """One push that must be refused, with its sentence naming the reason."""
    try:
        channel.register(payload)
    except channel.ChannelError as e:
        check(needle in str(e), f"{what} (said: {e})")
    else:
        check(False, what)


# ------------------------------------------------------------------- checks ---


def check_one_push_opens_the_door() -> None:
    client = Client()
    try:
        with isolated_host():
            cfg = Config()
            # The memo is warmed BEFORE the push: what is pinned below is that the
            # arrival alone invalidates it (generation is part of the signature),
            # not that a fresh process reads its sources once.
            check("clutch-probe" not in catalog.table(), "a warm table has no client component")

            before = channel.generation()
            held = _push(client, _plugin())
            check(held.generation == before + 1, "a push is a new generation")
            check(channel.holds("clutch-probe"), "the channel holds what was pushed")
            check("clutch-probe" in catalog.table(), "the pushed component enters the table with no invalidate")
            check(rendezvous.available("clutch-probe"), "and the door in unavailable_reason opens for it")
            check(rendezvous.unavailable_reason("clutch-probe") == "", "with no reason left to give")

            names = [t.name for t in build_tools(cfg)]
            check("probe_search" in names, "its tool joins the model's set")
            reg = ToolRegistry(build_tools(cfg))
            tool = reg.tool("probe_search")
            check(
                tool is not None and tool.remote and tool.inst is None and tool.host is None,
                "wired remote: no statement here and no host implementation",
            )
            check(reg.ui("probe_search")["mutates"] is False, "a plugin call is not a host mutation by default")
            check(reg.ui("probe_search")["undo"] is False, "and carries no undo record")

            ws = LocalWorkspace(tempfile.mkdtemp(prefix="clutch-channel-"))
            client.answer = {"content": "1. example.com — a result"}
            result = reg.execute(ws, cfg, "probe_search", {"q": "hello"})
            check(not result.error and result.content == "1. example.com — a result", "the call reaches the client")
            sent = client.calls[-1]
            check(sent["auth"] == f"Bearer {TOKEN}", "with the token the push gave, and nothing else")
            check(sent["path"] == channel.CALL_PATH, "on the channel's one path")
            check(
                sent["body"] == {"component": "clutch-probe", "tool": "probe_search", "args": {"q": "hello"}},
                "naming the component, the tool and the model's arguments",
            )

            # A failure the PLUGIN reports is the model's failure: an error result
            # reads as a failed call, never as a successful search that happens to
            # say "no results" in prose.
            client.answer = {"content": "the backend said no", "error": True}
            result = reg.execute(ws, cfg, "probe_search", {"q": "hello"})
            check(result.error and "the backend said no" in result.content, "a reported failure stays a failure")

            # One push REPLACES the set: the client is the source of truth for what
            # it runs, so a push that does not name a component is not "keep it".
            _push(client, _plugin(name="clutch-probe-b", tool="probe_b"))
            check(not channel.holds("clutch-probe") and channel.holds("clutch-probe-b"), "one push IS the whole set")
            check("probe_search" not in [t.name for t in build_tools(cfg)], "and the replaced tool is gone")
            check("clutch-probe" not in catalog.table(), "so is its declaration")

            # Clearing is the client going away.
            before = channel.generation()
            channel.clear()
            check(channel.generation() == before + 1, "clearing is a new generation too")
            check("clutch-probe-b" not in catalog.table(), "a cleared channel takes its components out of the table")
            # A PUSHED declaration lives and dies with the channel, so after a
            # clear there is no door left to explain: the name is simply unknown
            # here. (An INSTALLED runs_on=other declaration is the other case —
            # it stays in the table and says "no channel"; tests/catalog_test.py
            # pins that one.)
            reason = rendezvous.unavailable_reason("clutch-probe-b")
            check(not rendezvous.available("clutch-probe-b") and "unknown component" in reason, "and the door is shut again")
            check("probe_b" not in [t.name for t in build_tools(cfg)], "with no tool left to call")
    finally:
        channel.clear()
        client.close()


def check_a_dead_listener_is_a_sentence() -> None:
    """The reverse forward is the whole reach: when it is not up, the model reads
    why, not a traceback and not an empty success."""
    client = Client()
    port = client.port
    client.close()  # nothing listens there any more
    try:
        with isolated_host():
            cfg = Config()
            _push(type("C", (), {"port": port})(), _plugin())  # only the port is read
            ws = LocalWorkspace(tempfile.mkdtemp(prefix="clutch-channel-"))
            result = ToolRegistry(build_tools(cfg)).execute(ws, cfg, "probe_search", {"q": "x"})
            check(result.error, "a call with no listener behind the port fails")
            check("not answering" in result.content, "and says the channel is not answering")
    finally:
        channel.clear()


def check_a_bad_push_is_refused_whole() -> None:
    """Every word the channel cannot honor is a sentence, and a refused push leaves
    the set that was already there — half a set would be a tool surface nobody
    declared."""
    client = Client()
    try:
        with isolated_host():
            _push(client, _plugin())
            live = channel.current()

            good = {"port": client.port, "token": TOKEN, "components": [_plugin()]}
            _refused({}, "port must be", "a push without a port is refused")
            _refused({**good, "port": 0}, "port must be", "port 0 is not a port a client can listen on")
            _refused({**good, "port": "80"}, "port must be", "a port spelled as a string is refused")
            _refused({**good, "port": 70000}, "port must be", "an out-of-range port is refused")
            _refused({**good, "host": "10.0.0.5"}, "loopback", "a push may only name a loopback address")
            _refused({**good, "token": "short"}, "at least", "a token too short to be a secret is refused")
            _refused({**good, "token": "1234567890 abcde"}, "spaces", "a token with a space is refused")
            _refused({**good, "components": []}, "at least one component", "a push naming nothing is refused")
            _refused({**good, "components": "probe"}, "at least one component", "components must be a list")
            _refused({**good, "components": ["nope"]}, "not an object", "a component must be an object")
            _refused(
                {**good, "components": [{**_plugin(), "interface": "cli"}]},
                "only 'plugin' may be pushed",
                "a pushed component that is not a plugin is refused (that is an install)",
            )
            _refused(
                {**good, "components": [{**_plugin(), "runs_on": "self"}]},
                "say runs_on",
                "a plugin that claims to run here is refused (there is nothing to run)",
            )
            _refused(
                {**good, "components": [{**_plugin(), "runs_on": "server"}]},
                "unknown runs_on",
                "an unknown runs_on is fatal, on the channel as on the disk",
            )
            _refused(
                {**good, "components": [{**_plugin(), "launch": {"argv": ["{py}", "{script}"]}}]},
                "no launch on this host",
                "a plugin that declares how to start it here is refused",
            )
            bad_tool = _plugin()
            bad_tool["tools"][0]["command"] = "--envelope {q}"
            _refused(
                {**good, "components": [bad_tool]},
                "carries no command",
                "a plugin tool with a statement would be a second implementation",
            )
            _refused(
                {**good, "components": [dict(_plugin()), dict(_plugin())]},
                "twice",
                "the same component named twice in one push is refused",
            )
            bad_word = _plugin()
            bad_word["tools"][0]["access"] = "hax"
            _refused({**good, "components": [bad_word]}, "unknown access", "a word this host does not know is refused")

            check(channel.current() is live, "a refused push left the set that was there")
            check(channel.holds("clutch-probe"), "including the component it named")
    finally:
        channel.clear()
        client.close()


def _pushed_projection(manifest: dict) -> dict:
    """What `ui/plugin-server.js#declarations()` actually sends for one plugin.

    Kept beside the check rather than shared with anything: it exists to prove the
    shipped file works on the far side of the wire, and a helper the sender also
    used would prove only that the sender agrees with itself. Two things are
    dropped on purpose — `entry` (a path inside the installed version, which names
    this machine's files) and any tool field that says how to RUN something.
    """
    keep = ("name", "version", "interface", "runs_on", "subject", "requires", "ui", "prompt")
    pushed = {key: manifest[key] for key in keep if key in manifest}
    tools = []
    for tool in manifest.get("tools") or []:
        one = {"name": str(tool.get("name", "") or "")}
        if isinstance(tool.get("description"), str):
            one["description"] = tool["description"]
        if isinstance(tool.get("parameters"), dict):
            one["parameters"] = tool["parameters"]
        for word in ("access", "access_arg", "snapshot_arg", "modes", "gate", "preview"):
            if tool.get(word) not in (None, ""):
                one[word] = tool[word]
        tools.append(one)
    pushed["tools"] = tools
    return pushed


# The first REAL client plugin, in the submodule beside this repository. Its own
# node suite owns the behaviour; what is pinned here is the CLAIM the session reads.
CLIENT_PLUGIN = Path(__file__).resolve().parents[1] / "clutch-websearch" / "plugin" / "component.json"


def check_the_real_websearch_plugin() -> None:
    """The shipped `clutch-websearch/plugin/component.json` through the push parser.

    A plugin's declaration is a declaration: it is read by the same parser a
    manifest goes through, and the two fatal rules for this interface are that its
    tools carry a model-facing description and that they carry no statement a
    second host could try to run. A file that only ever travelled in a test would
    not catch a typo in the one that ships, so the real file is the input.
    """
    if not CLIENT_PLUGIN.exists():
        print(f"  skip: {CLIENT_PLUGIN} is not checked out (the submodule is absent)")
        return
    with isolated_host():
        manifest = json.loads(CLIENT_PLUGIN.read_text(encoding="utf-8"))
        check(manifest.get("interface") == "plugin", "the shipped plugin calls itself a plugin")
        check(manifest.get("runs_on") == "other", "and says its process runs on the client")

        pushed = _pushed_projection(manifest)
        check("entry" not in pushed, "its entry point stays on the machine that has the file")

        component = channel._plugin_of(pushed, 0)
        check(component.name == manifest["name"], "the push accepts it under its own name")
        check(
            [tool.name for tool in component.tools] == ["web_search", "web_fetch"],
            "carrying the two tools it publishes, in the order it publishes them",
        )
        check(
            all(isinstance(tool.description, str) and tool.description for tool in component.tools),
            "each with the prose the model is offered",
        )
        check(
            all(tool.command is None for tool in component.tools),
            "and no command line this host could be tricked into running",
        )
        check(
            not ({tool.name for tool in component.tools} & set(catalog.HOST_TOOL_NAMES)),
            "under no name the host already owns",
        )
        fatal = [d.message for d in catalog.component_diagnostics(component) if d.fatal]
        check(not fatal, f"with no fatal diagnostic ({'; '.join(fatal) or 'none'})")

        # The whole push, not just the one component: the file has to survive the
        # door it will actually walk through, not only the parser behind it.
        client = Client()
        try:
            held = _push(client, pushed)
            check(held.holds(component.name), "and a whole push holding it opens a door")
        finally:
            channel.clear()
            client.close()


def _request(url: str, method: str = "GET", body: dict | None = None) -> tuple[int, str, dict]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read().decode(), dict(response.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), dict(e.headers)


def _snapshot(root) -> list[str]:
    """Every path under the host root, uncompromised by filtering.

    Called only AFTER the table has been warmed: the one write a read may cause
    is the bootstrap of `catalog.d/table.json`, and that is the table doing its
    job. Everything after that point — a push, a clear, a call — must leave the
    tree exactly as it was, so this lists the whole thing, bookkeeping included.
    """
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))


def check_the_endpoint() -> None:
    """POST / GET / DELETE /api/channel, through the server's own handler.

    The endpoint is the only way a real client reaches this state, so the three
    verbs are pinned here: a push that is taken, a read-back that never repeats the
    token, and a delete that is the same state as "the client went away". The
    preflight admits DELETE, or a window on another origin could push and never
    clear.
    """
    client = Client()
    with isolated_host() as root:
        config = Config(port=0)
        # Warm the table before the snapshot: a read on a host with no table
        # bootstraps one, and that single write is bookkeeping rather than an
        # install. After it, the tree is a witness.
        build_tools(Config())
        before = _snapshot(root)
        server = build(config, Broadcaster(), RunState())
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{config.port}"
        try:
            status, body, _ = _request(f"{base}/api/channel")
            check(status == 200 and json.loads(body)["live"] is False, "a fresh session holds no channel")

            status, body, _ = _request(f"{base}/api/channel", "POST", {"port": client.port})
            check(status == 400 and "token" in json.loads(body)["error"], "a push without a token is a 400 with a reason")

            status, body, _ = _request(
                f"{base}/api/channel", "POST", {"port": client.port, "token": TOKEN, "components": [_plugin()]}
            )
            check(status == 200, "a good push is taken")
            state = json.loads(body)
            check(state["live"] is True and state["generation"] >= 1, "and the session is live at a new generation")
            check([c["name"] for c in state["components"]] == ["clutch-probe"], "naming the component it holds")
            check(state["components"][0]["tools"] == ["probe_search"], "and the tools behind it")
            check(TOKEN not in body, "the token is never read back out of the session")

            check("probe_search" in [t.name for t in build_tools(Config())], "the endpoint feeds the same channel the registry reads")

            status, body, _ = _request(f"{base}/api/channel")
            check(status == 200 and json.loads(body)["live"] is True, "GET answers what the session now holds")
            check(TOKEN not in body, "and still no token")

            status, _, headers = _request(f"{base}/api/channel", "OPTIONS")
            check(status == 204 and "DELETE" in headers.get("Access-Control-Allow-Methods", ""), "the preflight admits DELETE")

            status, body, _ = _request(f"{base}/api/channel", "DELETE")
            check(status == 200 and json.loads(body)["live"] is False, "DELETE is the client going away")
            check(not rendezvous.available("clutch-probe"), "and the door is shut")
            status, _, _ = _request(f"{base}/api/channel", "DELETE")
            check(status == 200, "deleting an empty channel is not an error")

            status, _, _ = _request(f"{base}/api/channel", "PUT")
            # 501 is BaseHTTPRequestHandler's answer for every verb this API does
            # not implement (`PUT /api/run` included), so it is refused rather
            # than silently accepted as a push.
            check(status == 501, "a verb the API does not implement is refused")

            after = _snapshot(root)
            check(before == after, "nothing a push or a clear does touches the machine's component root")
        finally:
            channel.clear()
            server.shutdown()
            server.server_close()
            client.close()


def check_the_machine_a_component_serves() -> None:
    """`subject` is a machine, and the surface follows it (SSH_WORKSPACE_PLAN C9.4).

    The situation two subjects exist for: the workspace's own `read_file`
    (`workspace-fs`, spoken to the machine the root lives on) and the ssh plugin's
    (`foreign-fs`, reached over a channel to another machine) publish the SAME name.
    Whose tool the model is offered has to follow the root's machine, not the order
    the table happened to fold — so both directions are pinned here, and so are the
    two sentences a call would read when only the wrong one is installed.
    """
    client = Client()
    with isolated_host() as root:
        code = root / "local-fs"
        code.mkdir()
        (code / "tool.py").write_text("#!/usr/bin/env python3\n", encoding="utf-8")
        local = _third_party("clutch-workspace", tool="read_file", directory=str(code))
        local["subject"] = "workspace-fs"
        _write_registration(local)
        try:
            cfg = Config()
            check(
                "read_file" in [t.name for t in build_tools(cfg)],
                "before any session, the local component's read_file is offered",
            )

            _push(client, _plugin(name="clutch-ssh-workspace", tool="read_file", subject="foreign-fs"))
            check(channel.holds("clutch-ssh-workspace"), "and the client's far-side component arrives over the channel")

            # a LOCAL root: the plugin's tools are dropped, not merely shadowed —
            # keeping them would put a foreign `read_file` in front of the one that
            # really works here (the table folds pushed declarations last).
            here = LocalWorkspace(tempfile.mkdtemp(prefix="clutch-c94-"))
            local_set = build_tools(cfg, workspace=here)
            check(
                [t.name for t in local_set].count("read_file") == 1,
                "a local root is offered ONE read_file, not a same-name pair",
            )
            check(
                ToolRegistry(local_set).tool("read_file").module == "clutch-workspace",
                "…the local component's, because this is the machine the root names",
            )
            check(
                "another machine" in module_blocked_reason(here, "clutch-ssh-workspace"),
                "and the far-side component answers for itself if it is asked anyway",
            )

            # a root on ANOTHER machine: the plugin's tool is the one that works.
            there = RemoteWorkspace("/srv/proj", "http://127.0.0.1:1/exec")
            remote_set = build_tools(cfg, workspace=there)
            check(
                [t.name for t in remote_set].count("read_file") == 2,
                "an ssh root sees both declarations of the name — the local one is kept on purpose",
            )
            tool = ToolRegistry(remote_set).tool("read_file")
            check(
                tool is not None and tool.remote and tool.module == "clutch-ssh-workspace",
                "…and the remote one is the tool the model calls (a push replaces by name, folded last)",
            )
            check(
                "another machine's" in module_blocked_reason(there, "clutch-workspace"),
                "while the local component's call reads why it cannot serve this root",
            )
            check(
                module_blocked_reason(there, "clutch-ssh-workspace") == "",
                "and the far-side component has nothing to explain for an ssh root",
            )

            # the subject, not the name or the interface, is what decides
            check(
                not rendezvous.serves_workspace_fs("clutch-ssh-workspace")
                and rendezvous.serves_foreign_fs("clutch-ssh-workspace"),
                "the two predicates answer for the two subjects and nothing else",
            )
            check(
                rendezvous.serves_workspace_fs("clutch-workspace") and not rendezvous.serves_foreign_fs("clutch-workspace"),
                "…symmetrically",
            )
        finally:
            channel.clear()
            client.close()


def main() -> int:
    check_one_push_opens_the_door()
    check_a_dead_listener_is_a_sentence()
    check_a_bad_push_is_refused_whole()
    check_the_real_websearch_plugin()
    check_the_machine_a_component_serves()
    check_the_endpoint()
    print("\nall passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
