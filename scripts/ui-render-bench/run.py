#!/usr/bin/env python3
"""Run scripts/ui-render-bench/bench.html in headless Chrome and report timings.

Serves the repository root (so the page can load ui/style.css and the vendored
libs by relative path), points Chrome at the benchmark page, collects the JSON
each experiment POSTs to /__bench, prints a report and rewrites
scripts/ui-render-bench/result.json.

    nohup python3 scripts/ui-render-bench/run.py > bench.log 2>&1 &

The bench needs ~2 minutes of wall time (two real-time stream simulations), so
it is meant to be backgrounded; --seconds caps it.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGE = "/scripts/ui-render-bench/bench.html"
RESULTS: list[dict] = []
DONE = threading.Event()


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # keep the log to the bench's own output
        pass

    def do_POST(self):  # noqa: N802
        if self.path != "/__bench":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        try:
            obj = json.loads(body)
        except json.JSONDecodeError:
            obj = {"exp": "unparsed", "raw": body[:200].decode("utf-8", "replace")}
        RESULTS.append(obj)
        print(f"[{time.strftime('%H:%M:%S')}] {json.dumps(obj, ensure_ascii=False)}", flush=True)
        if obj.get("exp") == "done":
            DONE.set()
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


def find_chrome() -> str | None:
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        p = shutil.which(name)
        if p:
            return p
    return None


def report(results: list[dict]) -> str:
    by: dict[str, list[dict]] = {}
    for r in results:
        by.setdefault(r.get("exp", "?"), []).append(r)
    out = ["", "=" * 74, "RENDER BENCH REPORT", "=" * 74]

    for r in by.get("env", []):
        out.append(f"env      : {r.get('ua','')[:80]} viewport={r.get('width')}x{r.get('height')} dpr={r.get('dpr')}")
    for r in by.get("raf", []):
        out.append(f"rAF      : {r.get('ticksIn500ms')} ticks in 500 ms (~{r.get('ticksIn500ms', 0) * 2}/s)")

    st = by.get("stages", [])
    if st:
        out += ["", "-- ONE FULL STREAMING RE-RENDER (ui/app.js renderTextBlock body) --",
                "   markdown = math-protect + marked.parse + restore + DOMPurify",
                "   STREAM   = innerHTML + highlightCode(root, true) + autoScroll  <- the per-120ms cost",
                f"{'answer':>9} {'fences':>6} {'markdown':>9} {'innerHTML':>10} {'hlCold':>8} "
                f"{'hlWarm':>8} {'layout':>7} {'flush FULL':>11} {'STREAM':>8}"]
        for r in st:
            out.append(
                f"{r['bytes']:>9} {r['fences']:>6} {r['markdownMs']:>9} {r['innerHtmlMs']:>10} "
                f"{r['hlColdMs']:>8} {r['hlWarmMs']:>8} {r['layoutMs']:>7} {r['fullRenderMs']:>11} "
                f"{r.get('streamRenderMs', '?')!s:>8}"
            )

    dd = by.get("domDepth", [])
    if dd:
        out += ["", "-- RENDER COST vs AN EXISTING TRANSCRIPT (16 KB answer) --",
                f"{'priorEvents':>11} {'domNodes':>9} {'renderMs':>9} {'autoScrollMs':>13} {'scrollHeight':>13}"]
        for r in dd:
            out.append(f"{r['priorEvents']:>11} {r['domNodes']:>9} {r['renderMs']:>9} "
                       f"{r['layoutOnlyMs']:>13} {r['streamScrollHeight']:>13}")

    for r in by.get("stream1", []) + by.get("stream2", []):
        tag = "with interloping non-text events" if r.get("interloperMs") else "text deltas only"
        out += ["", f"-- REAL-TIME STREAM ({r['bytes']} B, 60 deltas/s, 40 B each; {tag}) --",
                f"   wall {r['wallMs']} ms   renders {r['renders']} (forced {r['forcedRenders']})   "
                f"busy {r['busyMs']} ms = {r['busyPct']}% of one core",
                f"   avg render {r['avgRenderMs']} ms   worst render {r['maxRenderMs']} ms   "
                f"worst event-loop lag {r['lagMaxMs']} ms (clicks wait this long)"]

    an = by.get("analytic", [])
    if an:
        out += ["", "-- EXTRAPOLATED: MAIN-THREAD COST OF A WHOLE ANSWER (throttle honoured, 30 chars/s) --",
                f"{'answer':>9} {'renders':>8} {'mainThreadMs':>13}  (= seconds the UI cannot answer clicks)"]
        for r in an[0].get("rows", []):
            out.append(f"{r['bytes']:>9} {r['renders']:>8} {r['mainThreadMs']:>13}")

    for r in by.get("mermaid", []):
        out += ["", "-- MERMAID (24-node flowchart, main thread) --", f"   {r}"]

    ms = by.get("mermaidStream", [])
    if ms:
        out += ["", "-- MERMAID parse/render BY DIAGRAM SIZE (both on the main thread) --",
                f"{'nodes':>6} {'chars':>7} {'parseMs':>9} {'renderMs':>9}"]
        for r in ms:
            out.append(f"{r['nodes']:>6} {r['chars']:>7} {r['parseMs']!s:>9} {r['renderMs']!s:>9}")
    for r in by.get("mermaidStreamLoop", []):
        out += [f"   streamed 60-node diagram: {r['calls']} re-parses, {r['totalMs']} ms total, "
                f"avg {r['avgMs']} ms"]

    for r in by.get("math", []):
        out += ["", "-- MATHJAX --", f"   {r}"]

    pa = by.get("pathological", [])
    if pa:
        out += ["", "-- PATHOLOGICAL (but plausible) MODEL OUTPUT: renderMarkdown cost --",
                f"{'case':>16} {'chars':>8} {'markdownMs':>11}"]
        for r in pa:
            out.append(f"{r['name']:>16} {r['chars']:>8} {r['markdownMs']:>11}")
    last = [r for r in by.get("pathStart", [])]
    if last and not by.get("done"):
        out += [f"   (a hang would be attributable to: {last[-1]})"]

    known = {"env", "raf", "curve", "analytic", "stages", "domDepth", "stream1", "stream2",
             "mermaid", "mermaidStream", "mermaidStreamLoop", "math", "pathological",
             "pathStart", "done", "fatal"}
    extra = [r for r in results if r.get("exp") not in known]
    if extra:
        out += ["", "-- OTHER --"]
        out += [f"   {json.dumps(r, ensure_ascii=False)}" for r in extra]

    for r in by.get("fatal", []):
        out += ["", "-- FATAL --", f"   {r}"]

    out += ["", f"experiments posted: {len(results)}", "=" * 74]
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=300.0, help="hard cap on the run")
    ap.add_argument("--port", type=int, default=8731)
    args = ap.parse_args()

    chrome = find_chrome()
    if not chrome:
        print("no chrome/chromium found", file=sys.stderr)
        return 2

    handler = functools.partial(Handler, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    profile = tempfile.mkdtemp(prefix="clutch-bench-")
    url = f"http://127.0.0.1:{args.port}{PAGE}"
    cmd = [
        chrome,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-proxy-server",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--window-size=1440,900",
        f"--user-data-dir={profile}",
        url,
    ]
    print("launch:", " ".join(cmd), flush=True)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    started = time.time()
    try:
        while time.time() - started < args.seconds and not DONE.is_set():
            if proc.poll() is not None:
                print("chrome exited early", flush=True)
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    text = report(RESULTS)
    print(text, flush=True)
    (Path(__file__).parent / "result.json").write_text(
        json.dumps(RESULTS, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"elapsed {time.time() - started:.1f}s  results={len(RESULTS)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
