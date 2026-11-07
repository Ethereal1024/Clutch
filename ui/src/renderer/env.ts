// what kind of window this is — the two facts a module body reads at LOAD time
//
// The agent mode is asked for by render-events.ts on its last line (paint the
// stored mode on startup) and by nothing else at load; the platform is asked for
// by conn-store.ts while it wires the connection picker. Both are reads in a
// module's own body, so both need an owner that is initialized first whatever the
// graph does: a LEAF, like dom.ts, els.ts and state.ts (see els.ts for why the
// cycles make "who loads first" a thing no module may rely on).
//
// It is not state.ts: these are not bindings more than one module WRITES. The
// mode has exactly one writer (setMode, here, beside the value it owns) and the
// platform has none.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import { els } from "./els";

// agent mode for the next run: "work" (full tools) | "chat" (read-only); sticky per session
export let agentMode = localStorage.getItem("clutch_mode") || "work";

// Android shell (user report #2): the phone has no local backend of its own —
// the agent runs behind the SSH tunnel, so every "Local" affordance is dead
// weight there. UA sniff, no bridge plumbing: the WebView UA always carries
// the Android token, Electron/desktop UAs never do.
export const IS_ANDROID = /\bAndroid\b/.test(navigator.userAgent || "");

export function setMode(mode) {
  agentMode = mode === "chat" ? "chat" : "work";
  localStorage.setItem("clutch_mode", agentMode);
  els.mode.textContent = agentMode;
  els.mode.classList.toggle("chat-mode", agentMode === "chat");
  els.mode.title = agentMode === "chat"
    ? "chat: read-only analysis · click for work mode (full access). Applies to the next run."
    : "work: full access · click for chat mode (read-only analysis). Applies to the next run.";
}
