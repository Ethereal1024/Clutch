// startup — the settings mirror, the host's ui table, the boot sequence
//
// The last file loaded and the only one that runs the app: settle the base, fetch
// the host's own `ui` defaults before the first row is drawn, heal the settings
// mirror, open the stream.
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts,
// whose imports are the old page order) into ui/renderer.js, because Electron
// loads the page over file://, where Chromium refuses module scripts.

import "./bridge-shim";
import "./app";
import "./stream-view";
import "./tool-render";
import "./stream-events";
import "./stream-text";
import "./markdown";
import "./diagram-viewer";
import "./render-events";
import "./settings";
import "./update-panel";
import "./conn-store";
import "./components-panel";
import "./backend-lifecycle";
import "./conn-flow";
import "./conn-lost";
import "./permissions";
import "./workspace-panel";
import "./sse-stream";
import "./project";
import "./fs-browser";
import "./task-input";
import "./auto-fold";
import "./task-rollback";
import "./status-bar";
import "./tab-bar";
import { apiFetch, resolveApiBase } from "./app";
import { reconciledBackendUrl, switchBackend } from "./backend-lifecycle";
import { resumeTurn } from "./render-events";
import { connectSSE } from "./sse-stream";
import { state } from "./state";

// the flat LLM config this UI would mirror to ~/.clutch/settings.json, read
// from localStorage (the UI's own source of truth); null when nothing stored.
// Active profile first, then the legacy clutch_llm + clutch_api_key pair.
export function storedLlmConfig() {
  try {
    const active = localStorage.getItem("clutch_llm_active");
    const profiles = JSON.parse(localStorage.getItem("clutch_llm_profiles") || "{}");
    const p = active && profiles[active];
    if (p && (p.base_url || p.model || p.api_key)) {
      return {
        base_url: p.base_url || "",
        model: p.model || "",
        api_key: p.api_key || "",
        reasoning_effort: p.reasoning_effort || "",
        api_protocol: p.api_protocol || "",
      };
    }
  } catch (e) {}
  try {
    const legacy = JSON.parse(localStorage.getItem("clutch_llm") || "null");
    const key = localStorage.getItem("clutch_api_key") || "";
    if (legacy && (legacy.base_url || legacy.model || key)) {
      return {
        base_url: legacy.base_url || "",
        model: legacy.model || "",
        api_key: key,
        reasoning_effort: "",
        api_protocol: "",
      };
    }
  } catch (e) {}
  return null;
}

// rebuild the settings.json mirror if it went missing while the UI still has
// the config (fire-and-forget: the next session spawn / proxy request needs it)
export function healSettingsMirror() {
  const cfg = storedLlmConfig();
  if (!cfg) return; // nothing stored: nothing to heal from
  if (window.clutchSettings && window.clutchSettings.ensure) {
    window.clutchSettings.ensure(cfg).catch(() => {});
  }
}

// the host's own default `ui` block: fetched once at boot, before the first
// row is drawn, so the host's document (host.json) speaks through every event
// that carries no `ui` of its own. Best effort in both directions: an older
// host without the endpoint, or any fetch failure, leaves the compiled-in
// constants standing -- the renderer never waits on the network to draw.
export async function loadHostDefaults() {
  try {
    const data = await apiFetch("/api/host");
    if (data && data.ui) state.hostUiDefaults = data.ui;
  } catch (e) {} // constants remain the fallback
}

// settle the stored URL before connecting SSE; connectSSE is idempotent, so a
// switch inside reconciledBackendUrl (stale-SSH fallback, tunnel target) plus
// the trailing call still leaves exactly one live stream
(async () => {
  await resolveApiBase(); // learn this window's session port (IPC) first
  await loadHostDefaults(); // the host's own ui block, before any row is drawn
  healSettingsMirror();
  const url = await reconciledBackendUrl();
  if (url) switchBackend(url);
  connectSSE();
  // A boot that already knows a project can continue a turn the last page left
  // open (render-events.ts resumeTurn); one that does not gets the same call
  // when a project is opened, because that is when the log it can resume appears.
  resumeTurn();
  // Nothing dials a host on startup: a remembered remote stays a PRESELECTION in
  // the picker (conn-store.ts) until the user presses Connect there.
})();
