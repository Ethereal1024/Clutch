// bottom status bar — backend URL, model name, project path
//
// Reads three signals via document CustomEvents (to avoid circular imports)
// and keeps the footer strip in sync. The strip is defined in index.html
// (#statusbar) and styled in style.css (.statusbar / .sb-*).
//
// Signals:
//   clutch:status-changed  → detail = status string ("idle"|"running"|…)
//   clutch:project-info    → detail = {project, name}
//   clutch:backend-changed → detail = apiBase string | null
//
// stream-view.ts dispatches clutch:status-changed from setStatus().
// project.ts dispatches clutch:project-info from setProjectInfo().
// backend-lifecycle.ts dispatches clutch:backend-changed from switchBackendResolved().
//
// This file is a MODULE: what it uses, it imports above; what the others use,
// it exports. ui/build-renderer.js bundles the whole renderer (entry boot.ts).

import { $ } from "./dom";

const sbStatus  = $("#sb-status")  as HTMLElement;
const sbBackend = $("#sb-backend") as HTMLElement;
const sbModel   = $("#sb-model")   as HTMLElement;
const sbProject = $("#sb-project") as HTMLElement;

// ---- status ----
function paintStatus(s: string) {
  sbStatus.textContent = s || "idle";
  sbStatus.className = "sb-item sb-status " + (s || "idle");
}

document.addEventListener("clutch:status-changed", (ev: Event) => {
  paintStatus((ev as CustomEvent).detail);
});

// ---- backend ----
function hostPort(base: string | null): string {
  if (!base) return "—";
  try {
    const u = new URL(base);
    return u.host; // "127.0.0.1:8891" or "hostname:port"
  } catch {
    return base.replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 40);
  }
}

function paintBackend(base: string | null) {
  const label = hostPort(base);
  sbBackend.textContent = label;
  sbBackend.title = base || "no backend";
}

document.addEventListener("clutch:backend-changed", (ev: Event) => {
  paintBackend((ev as CustomEvent).detail);
});

// ---- model ----
function readActiveModel(): string {
  try {
    const active = localStorage.getItem("clutch_llm_active");
    if (!active) return "";
    const profiles = JSON.parse(localStorage.getItem("clutch_llm_profiles") || "{}");
    return (profiles[active] && profiles[active].model) || "";
  } catch {
    return "";
  }
}

function paintModel() {
  const m = readActiveModel();
  sbModel.textContent = m || "—";
  sbModel.title = m ? "model: " + m : "no model configured";
}

// repaint when settings are saved (the settings modal fires storage events in
// the same tab via a manual dispatch, since storage events are cross-tab only)
document.addEventListener("clutch:settings-saved", paintModel);
window.addEventListener("storage", (ev) => {
  if (ev.key === "clutch_llm_profiles" || ev.key === "clutch_llm_active") paintModel();
});

// ---- project ----
function paintProject(path: string, name: string) {
  if (!path) {
    sbProject.textContent = "—";
    sbProject.title = "no project open";
    return;
  }
  sbProject.textContent = name || path.split(/[/\\]/).pop() || path;
  sbProject.title = path;
}

document.addEventListener("clutch:project-info", (ev: Event) => {
  const d = (ev as CustomEvent).detail || {};
  paintProject(d.project || "", d.name || "");
});

// ---- initial paint ----
// apiBase is null at module load time (session resolves asynchronously),
// so backend shows "—" until clutch:backend-changed fires.
paintStatus("idle");
paintModel();
paintProject("", "");
