// startup — the settings mirror, the host's ui table, the boot sequence
//
// The last file loaded and the only one that runs the app: settle the base, fetch
// the host's own `ui` defaults before the first row is drawn, heal the settings
// mirror, open the stream.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// the flat LLM config this UI would mirror to ~/.clutch/settings.json, read
// from localStorage (the UI's own source of truth); null when nothing stored.
// Active profile first, then the legacy clutch_llm + clutch_api_key pair.
function storedLlmConfig() {
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
function healSettingsMirror() {
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
async function loadHostDefaults() {
  try {
    const data = await apiFetch("/api/host");
    if (data && data.ui) hostUiDefaults = data.ui;
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
  // Nothing dials a host on startup: a remembered remote stays a PRESELECTION in
  // the picker (js/conn-store.js) until the user presses Connect there.
})();
