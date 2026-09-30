// the renderer's entry — session base, request path, element table
//
// Resolves which backend this window talks to (the supervisor's IPC answer, the
// SSH tunnel, or a remembered remote), and owns the one JSON request path the rest
// of the UI goes through, plus the element table and the agent mode. Everything
// else is in ui/js/ (see the module list in index.html); this file loads first.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// Session API base. 8890 is the supervisor's lifecycle port: it answers
// /api/session/* and nothing a window can work with. It is a SENTINEL for "this
// window has no session yet" — never a URL to talk to. Routing a failed remote
// to it (the old "fallback") could only ever produce "Failed to fetch", and on
// the phone there is not even a supervisor behind it.
const SUPERVISOR_BASE = "http://127.0.0.1:8890";
let DEFAULT_BASE = SUPERVISOR_BASE; // this machine's session base, once resolved
let API_BASE = null; // resolved in resolveApiBase() before the app starts

async function resolveApiBase() {
  if (window.clutchApi && window.clutchApi.baseUrl) {
    // null/8890 = session not claimed yet (supervisor mid-spawn); retry
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const b = await window.clutchApi.baseUrl(); // IPC: this window's session port
        const clean = b ? String(b).replace(/\/+$/, "") : "";
        if (clean && clean !== SUPERVISOR_BASE) {
          API_BASE = clean;
          DEFAULT_BASE = clean;
          return clean;
        }
      } catch {
        /* preload unavailable — plain-browser debugging */
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  // Still unresolved: leave null. 8890 is the supervisor's port (no session
  // API); the main process announces the real URL via backend:base-changed.
  return API_BASE; // null
}

const $ = (s) => document.querySelector(s);

// A request needs a resolved base. Until the supervisor hands this window its
// session port API_BASE is null, and `null + "/api/host"` is not an error — it
// is the relative URL "null/api/host", which resolves against whatever origin
// served the UI and comes back a stray 404 (or, over file://, a network error
// nobody can act on). Refuse before the request instead; the error is shaped
// like an unreachable backend (`.code`, no `.status`), the path every caller
// already has for "could not talk to it".
function noBackend() {
  const e = new Error("no backend URL yet — the session is still starting");
  e.code = "no_backend";
  return e;
}

// single JSON request path: base URL, Content-Type header and error unwrapping
// live here instead of being re-written at every call site. Errors are thrown
// as `Error` with `.status` (HTTP status, absent for network failures — callers
// use it to tell "backend said no" from "backend unreachable") and `.code`
// (server error code, e.g. project_open_conflict). Throws on non-2xx and on a
// 200 body that carries an error (only /api/fs/list does that).
async function apiFetch(path, { method = "GET", body, base = API_BASE, timeout = 30000 } = {}) {
  if (!base) throw noBackend();
  // bounded: a hung backend must surface as a failed button, not a forever-
  // pending one (AbortError carries no .status -> callers treat it as
  // "backend unreachable", the same path as a refused connection)
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(base + path, body === undefined ? { method, signal: ctl.signal } : {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const e = new Error(data.error || r.status);
    e.code = data.code || null;
    e.status = r.status;
    throw e;
  }
  return data;
}

const els = {
  task: $("#task-input"),
  run: $("#run-btn"),
  mode: $("#mode-btn"),
  trust: $("#trust-btn"),
  status: $("#status"),
  stream: $("#stream"),
  tree: $("#tree"),
  workspace: $("#workspace-path"),
  projectLabel: $("#project-label"),
};

// agent mode for the next run: "work" (full tools) | "chat" (read-only); sticky per session
let agentMode = localStorage.getItem("clutch_mode") || "work";

// Android shell (user report #2): the phone has no local backend of its own —
// the agent runs behind the SSH tunnel, so every "Local" affordance is dead
// weight there. UA sniff, no bridge plumbing: the WebView UA always carries
// the Android token, Electron/desktop UAs never do.
const IS_ANDROID = /\bAndroid\b/.test(navigator.userAgent || "");

function setMode(mode) {
  agentMode = mode === "chat" ? "chat" : "work";
  localStorage.setItem("clutch_mode", agentMode);
  els.mode.textContent = agentMode;
  els.mode.classList.toggle("chat-mode", agentMode === "chat");
  els.mode.title = agentMode === "chat"
    ? "chat: read-only analysis · click for work mode (full access). Applies to the next run."
    : "work: full access · click for chat mode (read-only analysis). Applies to the next run.";
}

