// Logic test for the external-link navigation policy in ui/main.js
// (createWindow): model-provided links must open in the system browser via
// shell.openExternal, never navigate the app window (no back button otherwise).
// Mirrors the real handlers with stub webContents/shell, like mermaid-logic-test.
"use strict";

let failures = 0;
const check = (cond, name) => {
  if (cond) console.log("ok   " + name);
  else { failures++; console.log("FAIL " + name); }
};

// ---- the exact policy from ui/main.js (keep in sync) ----
// returns "open" (system browser) | "block" | "allow" (same-URL reload)
function externalUrlPolicy(url, current) {
  if (url.startsWith("http:") || url.startsWith("https:")) return "open";
  if (url !== current) return "block";
  return "allow";
}

// ---- stub the will-navigate / setWindowOpenHandler wiring ----
function makeWindow() {
  const calls = { openExternal: [], prevented: [] };
  const shell = { openExternal: (u) => calls.openExternal.push(u) };
  const win = {
    webContents: { getURL: () => "file:///app/index.html" },
    current: "file:///app/index.html",
  };
  // will-navigate handler (mirrors main.js)
  win.onWillNavigate = (event, url) => {
    const current = win.webContents.getURL();
    const act = externalUrlPolicy(url, current);
    if (act === "open") { event.preventDefault(); shell.openExternal(url); }
    else if (act === "block") { event.preventDefault(); }
  };
  // setWindowOpenHandler (mirrors main.js)
  win.onWindowOpen = ({ url }) => {
    const act = externalUrlPolicy(url, win.webContents.getURL());
    if (act === "open") shell.openExternal(url);
    return { action: "deny" }; // never open a new app window
  };
  return { win, calls };
}

// will-navigate: plain link clicks
{
  const { win, calls } = makeWindow();
  const ev = { preventDefault() { calls.prevented.push("will-navigate"); } };
  win.onWillNavigate(ev, "https://example.com/docs");
  check(calls.openExternal.length === 1 && calls.openExternal[0] === "https://example.com/docs", "https link -> openExternal + preventDefault");
  check(calls.prevented.length === 1, "https link navigation prevented");
}
{
  const { win, calls } = makeWindow();
  const ev = { preventDefault() { calls.prevented.push("will-navigate"); } };
  win.onWillNavigate(ev, "http://127.0.0.1:9000/x");
  check(calls.openExternal.length === 1 && calls.openExternal[0] === "http://127.0.0.1:9000/x", "http link -> openExternal");
  check(calls.prevented.length === 1, "http link navigation prevented");
}
{
  const { win, calls } = makeWindow();
  const ev = { preventDefault() { calls.prevented.push("will-navigate"); } };
  win.onWillNavigate(ev, "file:///app/foo.py"); // relative file link from model output
  check(calls.openExternal.length === 0, "file: link NOT handed to the OS (untrusted)");
  check(calls.prevented.length === 1, "file: link navigation prevented (app UI kept)");
}
{
  const { win, calls } = makeWindow();
  const ev = { preventDefault() { calls.prevented.push("will-navigate"); } };
  win.onWillNavigate(ev, "javascript:alert(1)");
  check(calls.openExternal.length === 0, "javascript: URL not opened externally");
  check(calls.prevented.length === 1, "javascript: URL blocked");
}
{
  const { win, calls } = makeWindow();
  const ev = { preventDefault() { calls.prevented.push("will-navigate"); } };
  win.onWillNavigate(ev, "file:///app/index.html"); // same-URL reload (Ctrl+R / location.reload)
  check(calls.openExternal.length === 0 && calls.prevented.length === 0, "same-URL reload allowed");
}

// setWindowOpenHandler: window.open / target=_blank
{
  const { win, calls } = makeWindow();
  const r = win.onWindowOpen({ url: "https://example.com" });
  check(calls.openExternal.length === 1 && r.action === "deny", "window.open(https) -> external + deny");
}
{
  const { win, calls } = makeWindow();
  const r = win.onWindowOpen({ url: "mailto:a@b.c" });
  check(calls.openExternal.length === 0 && r.action === "deny", "window.open(mailto) -> denied, not opened");

}

process.exit(failures ? 1 : 0);
