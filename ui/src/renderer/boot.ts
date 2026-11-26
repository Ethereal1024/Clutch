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
import "./countdown";
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
import "./dock";
import "./sse-stream";
import "./project";
import "./fs-browser";
import "./task-input";
import "./auto-fold";
import "./task-rollback";
import "./status-bar";
import "./tab-bar";
import "./titlebar";
import { apiFetch, resolveApiBase } from "./app";
import { reconciledBackendUrl, switchBackend } from "./backend-lifecycle";
import { state } from "./state";
import { resumeTurn } from "./render-events";
import { connectSSE } from "./sse-stream";
import { connLostExitPending } from "./conn-lost";
import { adoptBase, claimTab, onTabAutoConnect } from "./slots";
import { beginPaneLoad, showWelcome } from "./project";
import { connectTabMachine } from "./conn-flow";
import { corruptRecord, llmProfiles, notice } from "./settings";
import { tabActivate } from "./tab-bar";

// A RESTORED tab whose file lives on a machine this window is not on dials that
// machine itself, without waiting for a Connect press: the tab's own recorded
// host is the intent, and the cached password in ~/.clutch/settings.json (or the
// prompt conn-flow falls back to) makes the dial silent. Same cycle rule, other
// direction — slots.ts cannot import conn-flow.ts (project → slots) — so the
// dialer is handed in here too.
onTabAutoConnect(connectTabMachine);

// the flat LLM config this UI would mirror to ~/.clutch/settings.json, read
// from localStorage (the UI's own source of truth); null when nothing stored.
// Active profile first, then the legacy clutch_llm + clutch_api_key pair. Both
// records are read through the one reader that reports a record it cannot parse
// (settings.ts llmProfiles / corruptRecord): "unreadable" is not "nothing stored",
// and the caller below would otherwise do nothing about a real problem.
export function storedLlmConfig() {
  const active = localStorage.getItem("clutch_llm_active");
  const p = active ? llmProfiles()[active] : null;
  if (p && (p.base_url || p.model || p.api_key)) {
    return {
      base_url: p.base_url || "",
      model: p.model || "",
      api_key: p.api_key || "",
      reasoning_effort: p.reasoning_effort || "",
      api_protocol: p.api_protocol || "",
    };
  }
  const key = localStorage.getItem("clutch_api_key") || "";
  const legacyRaw = localStorage.getItem("clutch_llm");
  if (legacyRaw) {
    let legacy = null;
    try {
      legacy = JSON.parse(legacyRaw);
      // parses and is not the flat object this build writes (an array, a number, a
      // string) is the same failure the parse error is, just later: reported, not
      // read as "no endpoint set".
      if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
        throw new Error("it is not a flat endpoint record");
      }
    } catch (e) {
      corruptRecord("saved LLM endpoint (the older clutch_llm record)", "clutch_llm", e);
      legacy = null;
    }
    if (legacy && (legacy.base_url || legacy.model || key)) {
      return {
        base_url: legacy.base_url || "",
        model: legacy.model || "",
        api_key: key,
        reasoning_effort: "",
        api_protocol: "",
      };
    }
  }
  return null;
}

// rebuild the settings.json mirror if it went missing while the UI still has
// the config (fire-and-forget: the next session spawn / proxy request needs it).
// A heal that did not happen is said out loud: the file it could not write is the
// one every session child and the LLM proxy read.
export function healSettingsMirror() {
  const cfg = storedLlmConfig();
  if (!cfg) return; // nothing stored: nothing to heal from
  if (!(window.clutchSettings && window.clutchSettings.ensure)) return;
  const failed = (why) => notice("Could not rebuild ~/.clutch/settings.json: " + why);
  window.clutchSettings.ensure(cfg).then((r) => {
    if (r && r.ok === false) failed(r.error || "the host refused it");
  }, (e) => failed((e && e.message) || String(e)));
}

// the host's own default `ui` block: fetched once at boot, before the first
// row is drawn, so the host's document (host.json) speaks through every event
// that carries no `ui` of its own. A host that will not answer is SAID: the rows
// then come from this build's compiled-in constants, and the user is looking at
// defaults nobody confirmed instead of the host's own answer.
export async function loadHostDefaults() {
  try {
    const data = await apiFetch("/api/host");
    if (data && data.ui) state.hostUiDefaults = data.ui;
  } catch (e) {
    notice("The host did not describe its UI defaults (" + ((e && e.message) || e) +
      "); rows are drawn with this build's own, which may not be what it serves.", "info");
  }
}

// The boot above settles this window's session URL before the stream starts —
// and the base switches inside it (stale-SSH fallback, tunnel target) only HEAL:
// nothing is adopted yet, so none of them can open a stream. The one connect at
// the end of this IIFE is what starts the page's only stream.
(async () => {
  // Restored tabs own their sessions. Claiming the window's default slot too
  // would spawn a session nobody is looking at: the remembered tab claims its
  // OWN slot (project.ts activateTab) and every other restored tab stays lazy
  // until it is clicked.
  const restoredTabs = state.tabs.length > 0 && !connLostExitPending();
  if (!restoredTabs) {
    // No tab opens on this boot (an empty strip, or the conn-lost Cancel that
    // asked for the welcome page), so no tab may LOOK open either: the strip is
    // painted from the store, and the remembered id would highlight a tab
    // nothing is showing.
    if (state.activeTabId) {
      state.activeTabId = null;
      document.dispatchEvent(new CustomEvent("clutch:tab-state"));
    }
    await resolveApiBase(); // learn this window's session port (IPC) first
  }
  // The tab the last page was looking at — a hint from tab-bar.ts, never a
  // promise: its slot may be gone (host restarted, project deleted).
  const bootTab = restoredTabs
    ? state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0]
    : null;
  if (bootTab) {
    // The pane becomes this tab's LOAD now, before anything is claimed: the
    // claim's own hop (slots.ts → conn-flow connectTabMachine) reports into that
    // card, and a live load outranks the welcome page because both are views of
    // one state (pane.ts), not layers of a stack. A boot that ends with no
    // session calls showWelcome() again below.
    beginPaneLoad(bootTab);
    // Claim BEFORE the first draw: /api/host must be answered by the tab's own
    // host, and its `ui` block has to be in place for the rows the activation
    // paints. A failed claim leaves apiBase null, and the welcome page is next.
    const base = await claimTab(bootTab);
    if (base) adoptBase(base);
    // a claim slots.ts REFUSED says why (the tab's file is on a machine this
    // window is not on): that names the host, so say it rather than landing on
    // a welcome page with no explanation
    else if (bootTab.unreachable) notice(bootTab.unreachable, "info");
  }
  await loadHostDefaults(); // the host's own ui block, before any row is drawn
  healSettingsMirror();
  if (restoredTabs) {
    if (!bootTab || !state.apiBase) {
      // no session for the remembered tab: the welcome page is the honest view,
      // and the strip stays listed so a click can claim a slot again
      state.activeTabId = null;
      document.dispatchEvent(new CustomEvent("clutch:tab-state"));
      showWelcome();
      return;
    }
    await tabActivate(bootTab.id);
    // the activation claims the slot itself; if THAT found no session there is
    // nothing to stream, so say so on the welcome page instead of an empty pane
    if (!state.apiBase) {
      state.activeTabId = null;
      document.dispatchEvent(new CustomEvent("clutch:tab-state"));
      showWelcome();
    }
    return; // the activation opened the stream; a tab nobody clicked claims nothing
  }
  const url = await reconciledBackendUrl();
  if (url) switchBackend(url);
  // No tab opened on this boot, so the pane is the session's own resident window:
  // the empty project is the log it reads. This is an ADOPTION like any other —
  // the boot says which log, the same way a tab's open does — not a special case
  // inside the stream.
  connectSSE("");
  // A boot that already knows a project can continue a turn the last page left
  // open (render-events.ts resumeTurn); one that does not gets the same call
  // when a project is opened, because that is when the log it can resume appears.
  resumeTurn();
  // Nothing dials a host on startup JUST BECAUSE it is remembered: a remote the
  // window is not on stays a PRESELECTION in the picker (conn-store.ts) until
  // the user presses Connect there. The one thing that may dial is a restored
  // TAB whose own file lives there (slots.ts claimTab): that is not a
  // preselection, it is the resource the user asked the app to remember, and
  // without the hop the tab could only fail with "not a .clc project file".
})();

// ---- custom titlebar window controls ----------------------------------------
// Only wire up when running inside Electron (clutchWin is not exposed in the
// Android WebView or a plain browser).
if (typeof (window as any).clutchWin !== "undefined") {
  const cw = (window as any).clutchWin;
  document.querySelector(".tb-winbtn.minimize")?.addEventListener("click", () => cw.minimize());
  document.querySelector(".tb-winbtn.maximize")?.addEventListener("click", () => cw.maximize());
  document.querySelector(".tb-winbtn.close")   ?.addEventListener("click", () => cw.close());
}
