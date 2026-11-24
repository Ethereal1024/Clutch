"""Shared helpers for the standalone test runners: no test framework, each runner
is a plain `python -m tests.X` module. What is shared here is only what more than
one runner needs — the list of suites is the tests/ directory itself, not a file here.

- check()            fails fast: prints and exits non-zero on the first broken
                     assertion (the default)
- collecting_check() returns (check, failures) for runners that report every
                     broken assertion at the end (lazy_check, ui_fonts_check)
- http_get() / http_post()   drive the local HTTP API
- wait_gone()        prove a process did not leak (poll the pid until it is gone)
- posix_shell_argv() run POSIX sh text on this host for the mock "remote"
- MockBridge / start_bridge() / remote_root()
                     the inline `/exec` bridge two suites drive the SSH path
                     through (a temp directory played as another machine)
- ui_source()        the renderer's source, every module in page load order
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from agent.tools.localshell import local_shell, shq
from agent.tools.rendezvous import _pid_alive


def posix_shell_argv() -> list[str] | None:
    """How to run POSIX sh command text on THIS host, or None when the host has
    no POSIX shell at all.

    The mock "remote" side of the transport tests speaks POSIX sh — the real
    remote always does (exec-bridge.js runs `sh -c` there). On a POSIX app host
    that is /bin/sh; on Windows it has to be a real bash (Git for Windows /
    MSYS2), because subprocess(shell=True)/child_process.exec there is cmd.exe,
    which cannot run heredocs, `printf` or `base64` and would fail the mock for
    an environment reason rather than a product one.
    """
    if os.name != "nt":
        return ["/bin/sh", "-c"]
    shell = local_shell()  # the app's own detection (CLUTCH_BASH, Git dirs, PATH)
    return list(shell.argv) if shell.posix and shell.argv else None


def shell_words(command: str) -> list[str]:
    """How the SHELL will see a rendered command line: the argv a POSIX sh hands
    the child, with quoting resolved. Both statement suites assert on the words the
    module receives, so the reading is defined once."""
    return shlex.split(command, posix=True)


def wait_gone(pid: int, seconds: float = 5.0) -> bool:
    """True once `pid` is no longer alive, polling — a killed process is not reaped
    instantly, so a single liveness probe races the OS. Runners use this to prove a
    process did NOT leak (a daemon that dies with its parent, one that stops on
    release, one that survives a detach)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.05)
    return False


# --------------------------------------------- the mock "remote" (exec bridge) --

# The mock remote parses commands with a POSIX shell, exactly like the real
# remote's exec bridge (/bin/sh on POSIX, Git Bash / MSYS2 bash on Windows).
SH = posix_shell_argv()


def remote_root(path: str) -> str:
    """A local directory in the spelling the mock's POSIX shell resolves.

    The mock remote IS this machine's directory tree, seen through a POSIX
    shell: on Windows that shell (Git Bash) answers `/tmp` for %TEMP% (its own
    mount point) and keeps POSIX spellings in every path it prints, so the
    "remote" root must be spelled the way that shell spells it — the real
    remote is POSIX and only the mock needs the translation."""
    if os.name != "nt":
        return path
    return shell_pwd(path.replace("\\", "/"))


def shell_pwd(path: str) -> str:
    """How the mock's shell prints that directory (`pwd` under Git Bash answers
    /c/Users/... for C:\\Users\\... — the same directory, other spelling)."""
    assert SH is not None, "the mock remote needs a POSIX shell on this host"
    r = subprocess.run([*SH, f"cd {shq(path)} && pwd"], capture_output=True, text=True, timeout=30)
    return r.stdout.strip()


class MockBridge(BaseHTTPRequestHandler):
    """The far side of the tunnel: POST /exec {command} -> {code, stdout, stderr}.

    Same contract as the real exec bridge (`sh -c` on the remote), run against
    this machine so the SSH path can be driven without sshd or a second box; the
    "remote" root is a temp directory, spelled the way that shell spells it
    (`remote_root`)."""

    # peak exec-command length seen (chunking caps under the sshd limit)
    max_cmd_len = 0
    # total /exec POSTs issued (list_many batches a level into one exec)
    post_count = 0

    def log_message(self, *a) -> None:  # silence request spam
        pass

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/exec":
            self.send_response(404)
            self.end_headers()
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        cmd = body.get("command", "")
        MockBridge.max_cmd_len = max(MockBridge.max_cmd_len, len(cmd.encode("utf-8")))
        MockBridge.post_count += 1
        timeout_ms = body.get("timeout", 60000)
        try:
            r = subprocess.run(
                [*SH, cmd] if SH else cmd,
                shell=SH is None,
                capture_output=True,
                text=True,
                timeout=timeout_ms / 1000,
            )
            code, stdout, stderr = r.returncode, r.stdout or "", r.stderr or ""
        except subprocess.TimeoutExpired:
            code, stdout, stderr = -1, "", ""
        resp = json.dumps({"code": code, "stdout": stdout, "stderr": stderr}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(resp)


def start_bridge() -> tuple[ThreadingHTTPServer, str]:
    """(server, base_url) of a MockBridge on an ephemeral port; caller shuts it
    down. The thread is a daemon, so a crashed runner cannot leave it behind."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockBridge)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def check(cond: bool, name: str) -> None:
    if not cond:
        print(f"FAIL: {name}")
        sys.exit(1)
    print(f"ok:   {name}")


def collecting_check(indent: str = "") -> tuple[Callable[[bool, str], None], list[str]]:
    """Counterpart of check() for runners that summarize at the end: the returned
    check() prints and records instead of exiting, so the runner can report every
    failure (the banner wording differs per runner, hence it stays there)."""
    failures: list[str] = []

    def check(cond: bool, label: str) -> None:
        print(f"{indent}{'ok:  ' if cond else 'FAIL: '}{label}")
        if not cond:
            failures.append(label)

    return check, failures


def http_get(url: str) -> tuple[int, str]:
    """GET a local endpoint; returns (status, body) without raising on 4xx/5xx."""
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def http_post(url: str, body: dict | None = None) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def ui_source() -> str:
    """The renderer's source, in the order it runs — the Python twin of
    tests/harness.js's uiSource().

    The renderer used to be one file (ui/app.js), then a stack of classic scripts
    that ui/index.html listed in the only order that works. The sources are ES
    modules now (ui/src/renderer/*.ts) and the page loads one bundle
    (ui/renderer.js); boot.ts is the entry, and its side-effect imports ARE that
    old page order. Reading them is what keeps this reader and the page on one
    list: a constant that moves between modules keeps working and a module
    dropped from the imports shows up as a missing constant rather than passing
    silently. state.ts leads — it declares the bindings more than one module
    writes.
    """
    src = Path(__file__).resolve().parent.parent / "ui" / "src" / "renderer"
    boot = (src / "boot.ts").read_text(encoding="utf-8")
    order = re.findall(r'^import\s+"\./([\w-]+)";$', boot, re.M)
    if not order:
        raise AssertionError("boot.ts lists no side-effect imports — the load order is gone")
    order.append("boot")
    # the leaves (state.ts, dom.ts) are imported, not sequenced: they lead the text
    leaves = sorted(p.stem for p in src.glob("*.ts") if not p.name.endswith(".d.ts") and p.stem not in order)
    return "\n".join((src / (name + ".ts")).read_text(encoding="utf-8")
                     for name in leaves + order)
