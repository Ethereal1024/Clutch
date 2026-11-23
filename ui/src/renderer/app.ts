// the renderer's base — which session this window talks to, and the request path
//
// Resolves which backend this window talks to (the supervisor's IPC answer, the
// SSH tunnel, or a remembered remote), and owns the one JSON request path the rest
// of the UI goes through. Everything else is a module beside this one; boot.ts
// imports them all, in page order.
//
// The element handles (els.ts), the window's own facts (env.ts) and the shared
// mutable state (state.ts) are NOT here, and that is on purpose: modules read
// those in their own bodies, so they have to be initialized before any body runs,
// which a module everything else imports cannot promise (see els.ts).
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { connLostExitBootTeardown, connLostExitPending } from "./conn-lost";
import { state } from "./state";

// Session API base. 8890 is the supervisor's lifecycle port: it answers
// /api/session/* and nothing a window can work with. It is a SENTINEL for "this
// window has no session yet" — never a URL to talk to. Routing a failed remote
// to it (the old "fallback") could only ever produce "Failed to fetch", and on
// the phone there is not even a supervisor behind it.
export const SUPERVISOR_BASE = "http://127.0.0.1:8890";
export let DEFAULT_BASE = SUPERVISOR_BASE; // this machine's session base, once resolved

// What does the host hold for THIS window right now — its session URL, or nothing?
//
// This is the ONE ask, and every reader of this window's session goes through it
// (resolveApiBase below, backend-lifecycle.ts switchBackendResolved /
// tryDegradeToSshTools / reconciledBackendUrl), so the rules that belong to asking
// exist once instead of once per caller:
//
//   * the exit's note is read BEFORE the ask. A window that left an outage
//     (conn-lost.ts connLostQuit) claims nothing on the boot its reload opens:
//     the ask is answered from what the host still holds FOR THIS WINDOW
//     (claimWindowBackend), so a teardown that has not finished is still holding
//     the very session the user just left — this is what refuses to be handed it;
//   * the supervisor's lifecycle port is refused here as everywhere: it is a
//     SENTINEL for "no session yet", never a URL to talk to;
//   * null is an ANSWER, not a failure — the host looked and this window has no
//     session (no tunnel on it, and no local one either). Callers stay where they
//     are; the real URL, if one is coming, arrives via backend:base-changed.
export async function hostSessionUrl() {
  if (connLostExitPending()) return null;
  if (!(window.clutchApi && window.clutchApi.baseUrl)) return null;
  try {
    const b = await window.clutchApi.baseUrl(); // IPC: this window's session port
    const clean = b ? String(b).replace(/\/+$/, "") : "";
    if (clean && clean !== SUPERVISOR_BASE) return clean;
  } catch {
    /* preload unavailable — plain-browser debugging */
  }
  return null;
}

export async function resolveApiBase() {
  // The window before this one left (conn-lost Cancel, conn-lost.ts): it tore its
  // tunnel down and reloaded, and this is the ask that reload could still win by a
  // nose — baseUrl() is answered from what the host still holds FOR THIS WINDOW, so a
  // claim that landed before the teardown finished hands back the very session the
  // user just left. The note that exit left is read HERE, before anything is asked:
  // finish its teardown (bounded, idempotent) and claim nothing. The note is spent by
  // the user's own Connect (conn-flow.ts) — a boot nobody asked for is the only
  // one it can ever hold back, which is exactly the boot this is.
  if (connLostExitPending()) {
    await connLostExitBootTeardown();
    return null; // no session claimed: boot.ts sees null and dials nothing
  }
  // no preload at all (plain-browser debugging): there is nothing to ask, so there
  // is nothing to wait for
  if (!(window.clutchApi && window.clutchApi.baseUrl)) return state.apiBase; // null
  // null = session not claimed yet (supervisor mid-spawn); retry
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = await hostSessionUrl();
    if (url) {
      state.apiBase = url;
      DEFAULT_BASE = url;
      return url;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  // Still unresolved: leave null. 8890 is the supervisor's port (no session
  // API); the main process announces the real URL via backend:base-changed.
  return state.apiBase; // null
}

// A request needs a resolved base. Until the supervisor hands this window its
// session port API_BASE is null, and `null + "/api/host"` is not an error — it
// is the relative URL "null/api/host", which resolves against whatever origin
// served the UI and comes back a stray 404 (or, over file://, a network error
// nobody can act on). Refuse before the request instead; the error is shaped
// like an unreachable backend (`.code`, no `.status`), the path every caller
// already has for "could not talk to it".
export function noBackend() {
  const e = new Error("no backend URL yet — the session is still starting");
  e.code = "no_backend";
  return e;
}

// single JSON request path: base URL, Content-Type header and error unwrapping
// live here instead of being re-written at every call site. Errors are thrown
// as `Error` with `.status` (HTTP status, absent for network failures — callers
// use it to tell "backend said no" from "backend unreachable") and `.code`
// (server error code, e.g. project_open_conflict), plus `owner`/`project` when
// the server named them (a lock conflict: who holds it, which file it locked).
// Throws on non-2xx and on a
// 200 body that carries an error (only /api/fs/list does that).
// what a request may carry: `body` is JSON-encoded and omitted when it is
// undefined, `base`/`timeout` exist so the few pre-session callers (backend
// lifecycle, before API_BASE exists) can name a different host
export interface ApiFetchInit {
  method?: string;
  body?: any;
  base?: string;
  timeout?: number;
  // The caller's own cancellation. A tab switch supersedes whatever the tab it
  // left was still asking for, and the request has to END there rather than run
  // to completion into a pane that is another project's now: on a remote project
  // one abandoned answer is a 256 KB page off the tunnel, one after another, and
  // they are exactly the work that piles up behind the next switch.
  signal?: AbortSignal;
}
export async function apiFetch(path, { method = "GET", body, base = state.apiBase, timeout = 30000, signal }: ApiFetchInit = {}) {
  if (!base) throw noBackend();
  // bounded: a hung backend must surface as a failed button, not a forever-
  // pending one (AbortError carries no .status -> callers treat it as
  // "backend unreachable", the same path as a refused connection)
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  // the caller's abort is the same abort: one signal reaches the socket, and
  // whoever asked cannot tell our deadline from its own cancellation
  const onAbort = () => {
    try {
      ctl.abort();
    } catch (e) {
      /* already aborted by the deadline */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);
  }
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
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const e = new Error(data.error || r.status);
    e.code = data.code || null;
    e.status = r.status;
    // payload the page acts on rides along: who holds a conflicted project
    // (owner: pid/host/since/claim_pid) and the exact file the host locked
    if (data.owner) e.owner = data.owner;
    if (data.project) e.project = data.project;
    throw e;
  }
  return data;
}


