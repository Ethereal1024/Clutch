"""Offline checks for the MCP web-search plugin layer (loopback HTTP only).

Run: python -m tests.mcpbackend_test

Covers: provider URL resolution (settings > env), result mapping tolerance,
the JSON-RPC client (handshake, session id, SSE frames, plain-text and error
paths) against a real loopback server, backend gating (an MCP backend exists
only when configured — and is named nowhere when it is not), error-as-data
degradation, and dynamic rendering of prompt + schema.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import agent.tools.websearch as ws
from agent.config import Config
from agent.server import _login_state, _mcp_keys_from, _split_mcp_fields, mcp_providers
from agent.tools.mcpprovider import MCP_PROVIDERS
from agent.tools.registry import build_default_tools
from tests.testsupport import check


# ---- loopback MCP server ------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    """Scripted MCP server: initialize -> initialized -> tools/call."""

    behavior = "json"  # json | sse | text | error | rpcerror | empty

    def log_message(self, *a):  # silence the test run
        pass

    def do_POST(self):  # noqa: N802 (stdlib naming)
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        method = body.get("method", "")

        if method == "initialize":
            payload = {"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": ws._MCP_PROTO}}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Mcp-Session-Id", "sess-42")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())
            return

        if method == "notifications/initialized":
            self.send_response(202)
            self.end_headers()
            return

        call = self.path.strip("/") or _Handler.behavior
        if call == "error":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"boom")
            return
        if call == "rpcerror":
            payload = {"jsonrpc": "2.0", "id": 2, "error": {"code": -32602, "message": "bad params"}}
        elif call == "text":
            payload = {"jsonrpc": "2.0", "id": 2, "result": {"content": [{"type": "text", "text": "just words"}]}}
        elif call == "empty":
            self.send_response(202)
            self.end_headers()
            return
        else:
            rows = json.dumps([{"id": "abc", "title": "Note", "desc": "d", "xsec_token": "T"}])
            payload = {"jsonrpc": "2.0", "id": 2, "result": {"content": [{"type": "text", "text": rows}]}}
        text = json.dumps(payload)
        if call == "sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(f"event: message\ndata: {text}\n\n".encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(text.encode())


def main() -> None:
    xhs = MCP_PROVIDERS["xiaohongshu"]

    # 1. URL resolution: config dict wins over env, trailing / stripped
    check(xhs.url_for(Config()) == "", "provider without config resolves to ''")
    os.environ["CLUTCH_MCP_XIAOHONGSHU_URL"] = "http://env.example/mcp"
    try:
        check(xhs.url_for(Config()) == "http://env.example/mcp", "env CLUTCH_MCP_<NAME>_URL is the fallback")
    finally:
        del os.environ["CLUTCH_MCP_XIAOHONGSHU_URL"]
    cfg = Config()
    cfg.mcp_urls["xiaohongshu"] = "http://localhost:18060/mcp/"
    check(xhs.url_for(cfg) == "http://localhost:18060/mcp", "config beats env; trailing / stripped")

    # 2. result mapping: bare list and envelopes map; junk tolerated; token kept
    feeds = [
        {"id": "abc", "title": "Note", "desc": "body", "xsec_token": "T0K"},
        {"note_id": "n2", "title": "Second", "desc": "d2"},
        {"title": "no id, dropped"},
        "junk",
    ]
    rows = xhs.map_results(feeds)
    check(len(rows) == 2, "mapping keeps only rows with an id")
    check(
        rows[0]["url"] == "https://www.xiaohongshu.com/explore/abc?xsec_token=T0K",
        "mapping keeps xsec_token in the url",
    )
    check(rows[1]["url"] == "https://www.xiaohongshu.com/explore/n2", "mapping works without a token")
    check(xhs.map_results({"data": feeds}) == rows, "mapping unwraps a data envelope")
    check(xhs.map_results({"nope": 1}) == [], "mapping yields nothing on unknown shapes")

    # 3. settings-field helpers (server side)
    body = {"mcp_xiaohongshu": " http://localhost:18060/mcp/ ", "mcp_bad": "ftp://x", "model": "m"}
    try:
        _split_mcp_fields(body)
        check(False, "non-http mcp url rejected")
    except ValueError:
        check(True, "non-http mcp url rejected")
    clean = _split_mcp_fields({"mcp_xiaohongshu": " http://h/mcp/ ", "mcp_off": "", "api_key": "k"})
    check(clean == {"mcp_xiaohongshu": "http://h/mcp", "mcp_off": ""}, "mcp fields normalized ('' clears)")
    check(_mcp_keys_from({"mcp_x": "http://h", "base_url": "b"}) == {"mcp_x": "http://h"}, "mcp keys read back")
    check(_login_state({"login": True}) is True and _login_state({"status": "logged_in"}) is True,
          "login state normalized from common shapes")
    check(_login_state({"whatever": 1}) is None and _login_state(None) is None, "unknown login shape -> None")

    # 4. JSON-RPC client against a real loopback server
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"
    try:
        data = ws._mcp_call(base + "/", "search_feeds", {"keyword": "q"}, 5.0)
        check(isinstance(data, list) and data[0]["id"] == "abc", "tools/call result parses as json")

        _Handler.behavior = "sse"
        data = ws._mcp_call(base + "/sse", "search_feeds", {}, 5.0)
        check(isinstance(data, list) and data[0]["id"] == "abc", "SSE-framed reply handled")

        _Handler.behavior = "text"
        check(ws._mcp_call(base + "/text", "t", {}, 5.0) == "just words", "non-json text passes through")

        _Handler.behavior = "empty"
        check(ws._mcp_call(base + "/empty", "t", {}, 5.0) == "", "empty body (202) tolerated")

        _Handler.behavior = "rpcerror"
        try:
            ws._mcp_call(base + "/rpcerror", "t", {}, 5.0)
            check(False, "jsonrpc error raises WebError")
        except ws.WebError:
            check(True, "jsonrpc error raises WebError")

        _Handler.behavior = "error"
        try:
            ws._mcp_call(base + "/error", "t", {}, 5.0)
            check(False, "HTTP 500 raises WebError")
        except ws.WebError as e:
            check("500" in str(e), "HTTP 500 raises a factual WebError")

        try:
            ws._mcp_call("http://127.0.0.1:1/mcp", "t", {}, 1.0)
            check(False, "refused connection raises WebError")
        except ws.WebError as e:
            check("unreachable" in str(e) or "timed out" in str(e), "refused connection is a factual status")
    finally:
        srv.shutdown()
        srv.server_close()

    # 5. gating: unconfigured -> the backend does not exist anywhere
    plain = Config()
    avail = ws.available_backends(plain)
    check("xiaohongshu" not in avail, "unconfigured mcp backend absent from the chain")
    check("bing" in avail and "ddg" in avail, "keyless backends always available")
    r = ws.web_search(None, plain, "q", backend="xiaohongshu")
    check(r.get("error") and "available: " in r["content"], "pinning an unconfigured backend errors factually")
    check("install" not in r["content"].lower() and "needs CLUTCH_" not in r["content"],
          "error never suggests installing or setting env vars")
    check("searxng" not in r["content"], "unconfigured siblings are not named either")
    r = ws.web_search(None, plain, "q", backend="nope")
    check(r.get("error") and "available: " in r["content"] and "needs CLUTCH_" not in r["content"],
          "unknown backend lists only the real ones, no setup advice")

    # 6. configured -> the backend joins the chain and serves mapped results
    cfg2 = Config()
    cfg2.mcp_urls["xiaohongshu"] = base  # server is shut down: status-only impact below
    check("xiaohongshu" in ws.available_backends(cfg2), "configured mcp backend joins the chain")

    real_rpc = ws._mcp_rpc

    def fake_rpc(url, payload, session, timeout, cancel=None):
        if payload.get("method") == "initialize":
            return {"result": {}}, "sess-1"
        if payload.get("method") == "notifications/initialized":
            return {}, session
        rows_json = json.dumps([{"id": "f1", "title": "Found", "desc": "snippet", "xsec_token": "tk"}])
        return {"result": {"content": [{"type": "text", "text": rows_json}]}}, session

    ws._mcp_rpc = fake_rpc
    try:
        r = ws.web_search(None, cfg2, "note", backend="xiaohongshu")
        check(
            not r.get("error") and "Found" in r["content"] and "xsec_token=tk" in r["content"],
            "web_search serves mapped mcp results end to end",
        )

        def dead_rpc(*a, **k):
            raise ws.WebError("MCP server unreachable (refused): http://localhost:18060/mcp")

        ws._mcp_rpc = dead_rpc
        r = ws.web_search(None, cfg2, "note", backend="xiaohongshu")
        check(r.get("error") and "unreachable" in r["content"], "mcp failure degrades to error-as-data")
    finally:
        ws._mcp_rpc = real_rpc

    # 7. prompt + schema render dynamically from the configured set
    tools_plain = {t.name: t for t in build_default_tools(plain)}
    tools_xhs = {t.name: t for t in build_default_tools(cfg2)}
    check("xiaohongshu" not in tools_plain["web_search"].description,
          "prompt on an unconfigured host never names the mcp backend")
    check("xiaohongshu" in tools_xhs["web_search"].description,
          "prompt on a configured host names the mcp backend")
    check("bing | ddg" in tools_plain["web_search"].parameters["properties"]["backend"]["description"],
          "schema backend param lists the real chain")
    check(len(mcp_providers()) == 1, "server helper exposes the registry")

    print("all passed")


if __name__ == "__main__":
    main()
