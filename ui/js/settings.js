// the settings modal, the LLM profile store, and the shared overlay kit
//
// The custom select widget the whole UI uses, the LLM settings form and the
// profiles kept in localStorage (the UI's own source of truth for the model), and
// the overlay kit every modal is built from — dismissal, close animation, notice,
// confirm.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

// ---- task input auto-grow (grows as you type, shrinks back after sending) ----
const TASK_BASE_H = els.task.offsetHeight; // default 3-row height
function autoGrowTask() {
  const was = els.task.style.height;
  if (!els.task.value.trim()) {
    els.task.style.height = TASK_BASE_H + "px";
  } else {
    els.task.style.height = "auto";
    els.task.style.height = Math.min(els.task.scrollHeight, Math.round(window.innerHeight * 0.3)) + "px";
  }
  // the input resize clamps scrollTop; the listener ignores it, so re-pin while
  // typing to stay on the tail
  if (was !== els.task.style.height) {
    suppressLatchUntil = performance.now() + 120;
    if (followTail && !nearBottom()) autoScroll();
  }
}
els.task.addEventListener("input", autoGrowTask);

// ---- API settings modal ----
// endpoint persisted on the backend + client proxy; profiles pick the backend
//
// An option is { value, text } plus an optional MARK (opt.mark): a symbol (the
// SSH list's ✓, the profile list's ✓) drawn in a column of its own at the end of
// the row — and of the button — instead of being glued into the label. The
// difference is what happens to a name too long for the row: the LABEL is what
// gives way (…), so a marker can never wrap onto a second line, and can never
// drag the popup into a horizontal scrollbar. Both happened when the ✓ was the
// last characters of the text: unbreakable user@host:port labels overflowed to
// the right, and the space before the ✓ was the only break opportunity there
// was, so the tick dropped to the next line (device report).
function customSelect(root) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cselect-btn";
  if (root.getAttribute("title")) btn.title = root.getAttribute("title");
  const valueEl = document.createElement("span");
  valueEl.className = "cselect-value";
  const markEl = document.createElement("span"); // the selected option's mark, if it has one
  markEl.className = "cselect-mark";
  const arrow = document.createElement("span");
  arrow.className = "cselect-arrow";
  btn.appendChild(valueEl);
  btn.appendChild(markEl);
  btn.appendChild(arrow);
  const pop = document.createElement("div");
  pop.className = "cselect-pop";
  root.classList.add("cselect");
  root.appendChild(btn);
  root.appendChild(pop);

  const opts = []; // {value, text, mark}
  let selected = null;
  const listeners = [];

  function render() {
    const o = opts.find((x) => x.value === selected);
    valueEl.textContent = o ? o.text : "";
    markEl.textContent = (o && o.mark) || "";
    pop.innerHTML = "";
    for (const opt of opts) {
      const row = document.createElement("div");
      row.className = "cselect-opt" + (opt.value === selected ? " active" : "");
      const label = document.createElement("span");
      label.className = "cselect-opt-label";
      label.textContent = opt.text;
      row.appendChild(label);
      if (opt.mark) {
        const mark = document.createElement("span");
        mark.className = "cselect-mark";
        mark.textContent = opt.mark;
        row.appendChild(mark); // outside the label: it cannot wrap with it
      }
      row.addEventListener("click", () => {
        const changed = opt.value !== selected;
        selected = opt.value;
        render();
        root.classList.remove("open");
        if (changed) for (const fn of listeners) fn();
      });
      pop.appendChild(row);
    }
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // an empty picker is DISABLED, and a disabled control does not open: the
    // button is a real <button>, so only the class marks it (report #3)
    if (root.classList.contains("disabled")) return;
    root.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) root.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") root.classList.remove("open");
  });

  return {
    set innerHTML(_v) { opts.length = 0; selected = null; render(); }, // only ever cleared
    appendChild(opt) { opts.push({ value: opt.value, text: opt.textContent, mark: opt.mark || "" }); render(); },
    get value() { return selected || ""; },
    set value(v) { selected = v; render(); },
    get disabled() { return root.classList.contains("disabled"); },
    set disabled(b) { root.classList.toggle("disabled", !!b); },
    addEventListener(_ev, fn) { listeners.push(fn); },
    focus() { btn.focus(); },
  };
}

const modal = $("#settings-modal");
const keyInput = $("#api-key-input");
const modelInput = $("#model-input");
const reasoningEffortInput = customSelect($("#reasoning-effort-input"));
// reasoning-effort options
for (const [v, t] of [["", "default"], ["low", "low"], ["medium", "medium"], ["max", "max"]]) {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = t;
  reasoningEffortInput.appendChild(o);
}
reasoningEffortInput.value = "";
// wire protocol: empty = the endpoint's default (chat completions); providers
// serving the Responses API on the same base URL need the explicit choice
const apiProtocolInput = customSelect($("#api-protocol-input"));
for (const [v, t] of [["", "chat completions (default)"], ["responses", "responses API"]]) {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = t;
  apiProtocolInput.appendChild(o);
}
apiProtocolInput.value = "";
// "chat" in the settings file IS the default choice, so show it as such
function setApiProtocol(v) {
  apiProtocolInput.value = v === "chat" ? "" : v || "";
}
const llmUrlInput = $("#llm-url-input");
const profileSelect = customSelect($("#llm-profile-select"));

function llmProfiles() {
  try {
    return JSON.parse(localStorage.getItem("clutch_llm_profiles") || "{}");
  } catch (e) {
    return {};
  }
}

function saveLlmProfiles(profiles) {
  localStorage.setItem("clutch_llm_profiles", JSON.stringify(profiles));
}

function renderLlmProfiles(activeName) {
  const profiles = llmProfiles();
  profileSelect.innerHTML = "";
  const names = Object.keys(profiles).sort();
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === activeName) opt.mark = "✓"; // the tick is a marker, not part of the name
    profileSelect.appendChild(opt);
  }
  // empty list = no profiles: disable the picker
  profileSelect.disabled = names.length === 0;
  profileSelect.value = names.includes(activeName) ? activeName : (names[0] || "");
  // Delete/Edit act on the selected profile: grey them out when none is selected
  $("#llm-profile-del").disabled = !profileSelect.value;
  $("#llm-profile-edit").disabled = !profileSelect.value;
}

// apply a saved profile: fill the form and push it to the backend immediately
async function applyLlmProfile(name) {
  const p = llmProfiles()[name];
  if (!p) return;
  keyInput.value = p.api_key || "";
  llmUrlInput.value = p.base_url || "";
  modelInput.value = p.model || "";
  reasoningEffortInput.value = p.reasoning_effort || "";
  setApiProtocol(p.api_protocol);
  localStorage.setItem("clutch_llm_active", name);
  renderLlmProfiles(name);
  await pushSettings();
}

profileSelect.addEventListener("change", async () => {
  const name = profileSelect.value;
  if (name) await applyLlmProfile(name);
  else renderLlmProfiles("");
});

const profileNameInput = $("#llm-profile-name");

function saveProfileAs(name, oldName) {
  const profiles = llmProfiles();
  if (oldName && oldName !== name) delete profiles[oldName]; // rename: drop the old key
  profiles[name] = {
    base_url: llmUrlInput.value.trim(),
    model: modelInput.value.trim(),
    api_key: keyInput.value.trim(),
    reasoning_effort: reasoningEffortInput.value.trim(),
    api_protocol: apiProtocolInput.value.trim(),
  };
  saveLlmProfiles(profiles);
  localStorage.setItem("clutch_llm_active", name);
  renderLlmProfiles(name);
}

// ---- LLM profile editor (mirrors the SSH connection modal) ----
// pick to apply, ＋ New (blank), Edit, Delete; url/key/model fields live here
const llmProfileModal = $("#llm-profile-modal");
const llmProfileTitle = $("#llm-profile-title");
const llmProfileError = $("#llm-profile-error");
let editingProfile = null; // the profile being edited, or null for a new one

function showLlmProfileError(msg) {
  llmProfileError.textContent = msg;
  llmProfileError.classList.remove("hidden");
  profileNameInput.classList.add("profile-name-error");
}
function clearLlmProfileError() {
  llmProfileError.classList.add("hidden");
  llmProfileError.textContent = "";
  profileNameInput.classList.remove("profile-name-error");
}

function openLlmProfileEditor(name) {
  // ＋ New (no name) opens a BLANK form; Edit prefills the selected profile
  const p = name ? llmProfiles()[name] : null;
  editingProfile = name && p ? name : null;
  llmProfileTitle.textContent = editingProfile ? "Edit profile: " + editingProfile : "New LLM profile";
  profileNameInput.value = editingProfile || "";
  llmUrlInput.value = (p && p.base_url) || "";
  keyInput.value = (p && p.api_key) || "";
  modelInput.value = (p && p.model) || "";
  reasoningEffortInput.value = (p && p.reasoning_effort) || "";
  setApiProtocol(p && p.api_protocol);
  clearLlmProfileError();
  llmProfileModal.classList.remove("hidden", "closing");
  profileNameInput.focus();
}
function closeLlmProfileEditor() {
  editingProfile = null;
  closeModal(llmProfileModal);
}

$("#llm-profile-new").addEventListener("click", () => openLlmProfileEditor());
$("#llm-profile-edit").addEventListener("click", () => openLlmProfileEditor(profileSelect.value));
$("#llm-profile-cancel").addEventListener("click", closeLlmProfileEditor);
dismissOnOverlayPress(llmProfileModal, closeLlmProfileEditor);

$("#llm-profile-save").addEventListener("click", async () => {
  const name = profileNameInput.value.trim();
  if (!name) {
    clearLlmProfileError();
    showLlmProfileError("Give this profile a name.");
    profileNameInput.focus();
    return;
  }
  // a name conflicts only when it belongs to a DIFFERENT profile
  const taken = llmProfiles()[name];
  if (taken && name !== editingProfile) {
    showLlmProfileError("A profile named \"" + name + "\" already exists — pick a different name.");
    profileNameInput.focus();
    return;
  }
  const oldName = editingProfile;
  editingProfile = null;
  saveProfileAs(name, oldName);
  closeModal(llmProfileModal);
  await pushSettings(); // apply the new/edited profile to the backend
});

profileNameInput.addEventListener("input", clearLlmProfileError);

profileNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("#llm-profile-save").click();
  }
});

$("#llm-profile-del").addEventListener("click", async () => {
  const name = profileSelect.value;
  if (!name) return; // nothing selected: nothing to delete
  const yes = await askConfirm({
    title: "Delete LLM profile",
    text: 'Delete profile "' + name + '"?',
    ok: "Delete",
  });
  if (!yes) return;
  const profiles = llmProfiles();
  delete profiles[name];
  saveLlmProfiles(profiles);
  if (localStorage.getItem("clutch_llm_active") === name) localStorage.removeItem("clutch_llm_active");
  renderLlmProfiles("");
});

async function openSettings() {
  modal.classList.remove("hidden", "closing");
  // url/key/model fields live in the profile editor; nothing to prefill here
  renderLlmProfiles(localStorage.getItem("clutch_llm_active") || "");
  // always open on the model tab: the plugin page is a place a user goes, not
  // the place they land (and its lists are re-read when they do)
  showSettingsTab("llm");
}
function closeSettings() {
  closeModal(modal);
}

// ---- the settings modal's two panes ----
// A tab strip over one modal box: "Model" (the LLM profile form) and "Plugins"
// (ui/js/components-panel.js). Purely visual — this only moves a class; the
// plugin pane draws itself when it becomes visible.
//
// The strip is a real `role="tablist"` in index.html, and `aria-selected` is the
// half of it a class cannot say: `.active` paints the tab, `aria-selected` is how
// the pane that is showing is announced. Both tabs stay in the tab order and there
// are no arrow keys — with two of them, Tab reaches the other one, which is what a
// reader expects anyway.
const SETTINGS_TABS = ["llm", "plugins"];
function showSettingsTab(name) {
  const tab = SETTINGS_TABS.includes(name) ? name : "llm";
  for (const t of SETTINGS_TABS) {
    const btn = $("#settings-tab-" + t);
    const on = t === tab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
    $("#settings-pane-" + t).classList.toggle("hidden", !on);
  }
}
for (const t of SETTINGS_TABS) {
  $("#settings-tab-" + t).addEventListener("click", () => showSettingsTab(t));
}
// push the profile-editor form values to the backend
async function pushSettings() {
  const key = keyInput.value.trim();
  const llmUrl = llmUrlInput.value.trim();
  const model = modelInput.value.trim();
  const payload = {
    base_url: llmUrl,
    model,
    // always sent: empty values clear the knobs on the backend
    reasoning_effort: reasoningEffortInput.value.trim(),
    api_protocol: apiProtocolInput.value.trim(),
  };
  if (key) payload.api_key = key;
  try {
    await apiFetch("/api/settings", { method: "POST", body: payload });
    if (key) localStorage.setItem("clutch_api_key", key);
    localStorage.setItem("clutch_llm", JSON.stringify({ model, base_url: llmUrl }));
    // keep the client-side LLM proxy in sync (it reads the local settings file).
    // The knobs ride along with the model here too: this mirror is what a
    // session claim reads back (host-core remoteLlmKnobs), and an omitted knob
    // means "keep the stored one", so a save without them would leave a remote
    // claim forwarding nothing.
    if (window.clutchSettings && window.clutchSettings.save) {
      await window.clutchSettings.save({
        api_key: key,
        model,
        base_url: llmUrl,
        reasoning_effort: payload.reasoning_effort,
        api_protocol: payload.api_protocol,
      });
    }
    return true;
  } catch (e) {
    addEvent({ type: "final", status: "error", summary: "save settings failed: " + e.message });
    return false;
  }
}
$("#settings-btn").addEventListener("click", openSettings);
$("#settings-close").addEventListener("click", closeSettings);
dismissOnOverlayPress(modal, closeSettings);

// close only when the press STARTS on the overlay (a drag released outside
// must not close it)
function dismissOnOverlayPress(overlayEl, onClose) {
  overlayEl.addEventListener("mousedown", (e) => {
    if (e.target === overlayEl) onClose();
  });
}

const MODAL_CLOSE_MS = 180;

// animated close: fade the overlay, then land display:none when done
function closeModal(overlayEl, onDone) {
  if (!overlayEl || overlayEl.classList.contains("hidden") || overlayEl.classList.contains("closing")) return;
  const finish = () => {
    // reopened before the animation finished: this stale timer must not hide it
    if (!overlayEl.classList.contains("closing")) return;
    overlayEl.classList.remove("closing");
    overlayEl.classList.add("hidden");
    if (onDone) onDone();
  };
  overlayEl.classList.add("closing");
  if (reducedMotion()) finish();
  else setTimeout(finish, MODAL_CLOSE_MS);
}

// ---- in-page feedback: notice + confirm -------------------------------
// The phone's WebView has no WebChromeClient, so the renderer's own dialogs are
// dead there: alert() is a no-op and confirm() returns false without drawing
// anything. A failure reported only through alert() therefore reads as "my tap
// did nothing" (device report: opening another project from the phone's picker),
// and a question asked through confirm() is always answered "no" (the read-only
// offer, deleting an LLM profile). Both have a real surface here.

// one self-dismissing line at the bottom of the viewport; never intercepts a
// tap, never covers a dialog (z-index below .modal)
let noticeTimer = null;
function notice(message, kind = "error") {
  const el = document.getElementById("notice");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  el.classList.toggle("error", kind === "error");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.add("hidden"), kind === "error" ? 8000 : 4000);
}

const confirmModal = $("#confirm-modal");
let confirmResolve = null;
// promise-based: `if (await askConfirm({...})) ...` replaces `if (!confirm(...))`
function askConfirm({ title, text, ok = "OK", cancel = "Cancel" }) {
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = ok;
  $("#confirm-cancel").textContent = cancel;
  confirmModal.classList.remove("hidden", "closing");
  $("#confirm-ok").focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}
function closeConfirm(answer) {
  if (!confirmResolve) return;
  const resolve = confirmResolve;
  confirmResolve = null; // settle before the close animation: a re-press cannot double-answer
  closeModal(confirmModal);
  resolve(answer);
}
$("#confirm-ok").addEventListener("click", () => closeConfirm(true));
$("#confirm-cancel").addEventListener("click", () => closeConfirm(false));
dismissOnOverlayPress(confirmModal, () => closeConfirm(false));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || confirmModal.classList.contains("hidden")) return;
  closeConfirm(false);
});

