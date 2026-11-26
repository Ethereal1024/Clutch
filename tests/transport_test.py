"""Transport checks: the output decoder, and LocalTransport's run/cancel/timeout.

Run: uv run python -m tests.transport_test

The workspace's commands run on THIS machine through LocalTransport, so what is
checked here is the surface every tool call goes through: how a child's bytes are
decoded (the Windows GBK regression), that a plain command answers, and that Stop
and the deadline both end the wait promptly with TransportError saying which of
the two it was.
"""

from __future__ import annotations

import sys
import tempfile
import threading
import time
from pathlib import Path

from agent.tools.localshell import local_shell, shq
from agent.tools.transport import LocalTransport, TransportError
from agent.tools.workspace import LocalWorkspace
from tests.testsupport import check, posix_shell_argv

# the host's POSIX shell (/bin/sh, Git Bash / MSYS2 bash on Windows), or None
SH = posix_shell_argv()


def check_decoding() -> None:
    """The output decoder: UTF-8 when the bytes are UTF-8, the host's code page
    when they are not, and never U+FFFD for text the machine could read.

    This is the Windows regression: a Chinese Windows box's cmd.exe builtins and
    console programs write GBK (code page 936), so a plain utf-8/replace decode
    handed the model replacement characters for every line containing Chinese.
    The code-page list is pinned to cp936 here so the GBK half is exercised on
    every host — on a Chinese Windows box that IS the real answer, elsewhere it
    stands in for it.
    """
    from agent.tools import transport as tr

    saved = tr._fallback_encodings
    tr._fallback_encodings = ("cp936",)
    try:
        zh = "中文输出"
        check(tr.decode_output(zh.encode("utf-8")) == zh, "UTF-8 output decodes unchanged")
        check(tr.decode_output(zh.encode("gbk")) == zh, "GBK output decodes as GBK, not U+FFFD")
        check(tr.decode_output(b"") == "", "empty output stays empty")
        # one command, two writers (a Git Bash UTF-8 line, then a Windows exe's GBK one)
        mixed = "第一行\n".encode("utf-8") + "第二行\n".encode("gbk")
        check(tr.decode_output(mixed) == "第一行\n第二行\n", "mixed UTF-8/GBK lines each decode")
        # a GBK trail byte 0x85 must stay inside its character (it is 0x8185 = 亝)
        check(tr.decode_output("亝".encode("gbk") + b"\n") == "亝\n", "a 0x85 trail byte is not a line break")
        check(tr.decode_output(b"a\r\nb\r\n") == "a\r\nb\r\n", "ASCII/CRLF output unchanged")
        check(tr.decode_output(b"\xff\xff") == "\ufffd\ufffd", "truly undecodable bytes degrade to U+FFFD")

        # end to end through the real pipes: a child that writes GBK — what
        # cmd.exe builtins and a cp936 Python do on a Chinese box — reaches
        # CommandResult as text, not U+FFFD
        if local_shell().posix:
            with tempfile.TemporaryDirectory() as d:
                gbk = "".join("\\%03o" % c for c in "中文测试".encode("gbk"))
                r = tr.LocalTransport(d).run(f"printf '{gbk}\\n'", 30.0)
                check(r.stdout.strip() == "中文测试", f"a GBK-writing child decodes end to end ({r.stdout!r})")
    finally:
        tr._fallback_encodings = saved


def main() -> int:
    check_decoding()

    with tempfile.TemporaryDirectory() as rtmp:
        made = Path(rtmp) / "init-made" / "deep"
        _ = LocalWorkspace(str(made))
        check(made.is_dir(), "LocalWorkspace creates its root")

        if SH is None:
            print("SKIP: no POSIX shell on this host (Windows without Git Bash / MSYS2)")
            print("      the cancel/timeout checks run a real `sleep`, so they need one.")
            print("\nall passed")
            return 0

        # ---- Stop during a command: the cancel event kills the wait promptly ----
        lt = LocalTransport(rtmp)

        # baseline: the rewritten path still runs plain commands
        r = lt.run("echo hi", 30.0)
        check(r.code == 0 and r.stdout.strip() == "hi", "LocalTransport plain run after the rewrite")

        # and Chinese output arrives as TEXT, not U+FFFD — the shell on this host
        # may answer in UTF-8 (POSIX sh, Git Bash) or GBK (a Chinese box's
        # cmd.exe), and both must reach the model readable
        r = lt.run("echo 中文输出", 30.0)
        check(r.code == 0 and r.stdout.strip() == "中文输出", f"Chinese command output decodes ({r.stdout!r})")

        # Stop mid-command: TransportError(aborted=True) in ~1s, not after the
        # command; the `touch` after the sleep also proves the TREE died (no
        # late write from a survivor — taskkill /T locally, killpg on POSIX)
        late = Path(rtmp) / "late.txt"
        cancel = threading.Event()
        threading.Timer(0.7, cancel.set).start()
        t0 = time.monotonic()
        try:
            lt.run(f"sleep 120 && touch {shq(str(late))}", 300.0, cancel=cancel)
            check(False, "cancelled local command raises TransportError")
        except TransportError as e:
            elapsed = time.monotonic() - t0
            check(e.aborted and not e.timeout, f"local cancel -> TransportError(aborted=True) (timeout={e.timeout})")
            check(elapsed < 10, f"local cancel aborts promptly (took {elapsed:.1f}s)")
        time.sleep(1.0)  # a survivor would write its marker within this window
        check(not late.exists(), "the killed tree never ran its tail (no late writes)")

        # the deadline path still surfaces as TransportError(timeout=True)
        t0 = time.monotonic()
        try:
            lt.run("sleep 120", 1.0)
            check(False, "local timeout raises TransportError")
        except TransportError as e:
            check(e.timeout and not e.aborted, "local deadline -> TransportError(timeout=True)")
            check(time.monotonic() - t0 < 10, "local timeout is prompt")

    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
