// the plugin tab: which machine this window is working with, what that machine
// holds, and what this client could give it
//
// Three facts, drawn as they arrive (ui/components-view.js answers them over the
// clutchComponents channel):
//   * the TARGET — the machine's SUPERVISOR, not the session API the rest of the
//     UI talks to (a session child serves no /api/components). Local, or the far
//     side of a tunnel; ui/main.js resolves which one, this file only names it.
//   * what that machine HOLDS, from its own inventory.
//   * the MARKET this client knows: the checkouts beside the host repo plus every
//     release manifest its source list names.
//
// A read that failed is DATA here, never a blank page: the supervisor that did
// not answer and the source that did not answer are both drawn as the reason
// they did not. "No plugins exist" and "the network ate the answer" look exactly
// alike in an empty list, and that is the one reading this page must not give.
//
// The one write this page can perform is an install, and it is offered the way
// PLUGIN_PLAN.md I5 demands: the button says what it will do to WHICH machine,
// the confirmation says a component cannot be taken back from here (no uninstall
// exists on the host), and the outcome is the host's own verdict, quoted. A read
// that failed never becomes an offer to write: an unreachable target disables
// the button instead of pretending the install will land.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

const plugBodyEl = $("#plug-body");
const plugTargetEl = $("#plug-target");
const plugBaseEl = $("#plug-base");
const plugNoteEl = $("#plug-note");
const plugReloadBtn = $("#plug-reload");

const plugState = {
  target: null, // {kind, base} — which machine this page is about
  held: null, // its inventory, or null while unread
  heldError: null, // why that could not be read
  market: null, // {entries, errors, sources}
  marketError: null, // why the market read itself failed
  pending: 0, // in-flight reads: the note line is derived from them
  busy: null, // {name, stage} — an install in flight, nothing else may start
  result: null, // {ok, text} — the host's verdict on the last install
};

// The machine this page is about, named the way the rest of the UI names it: the
// SSH host this window is connected to when one is saved, else this machine. The
// URL below it is the authority — a name is a label, never the target.
function plugTargetName(target) {
  if (!target) return "…";
  if (target.kind !== "remote") return "Local (this machine)";
  const host = localStorage.getItem("clutch_ssh_host");
  const user = localStorage.getItem("clutch_ssh_user");
  const port = localStorage.getItem("clutch_ssh_port");
  const connected = localStorage.getItem("clutch_api_url") && localStorage.getItem("clutch_ssh_connected");
  const label = host ? `${user ? user + "@" : ""}${host}${port ? ":" + port : ""}` : "the tunneled machine";
  return `SSH ${label}${connected ? " ✓" : ""}`;
}

function plugChip(text, cls) {
  const el = document.createElement("span");
  el.className = "plug-chip" + (cls ? " " + cls : "");
  el.textContent = text;
  return el;
}

// one row: the name, what it is, and whatever it makes of the target machine
function plugRow(name, chips, lines, actions = []) {
  const row = document.createElement("div");
  row.className = "plug-row";
  const head = document.createElement("div");
  head.className = "plug-row-head";
  const nameEl = document.createElement("span");
  nameEl.className = "plug-name";
  nameEl.textContent = name;
  head.appendChild(nameEl);
  for (const [text, cls] of chips) head.appendChild(plugChip(text, cls));
  if (actions.length) {
    const box = document.createElement("span");
    box.className = "plug-row-actions";
    for (const a of actions) box.appendChild(a);
    head.appendChild(box);
  }
  row.appendChild(head);
  for (const line of lines) {
    if (!line) continue;
    const el = document.createElement("div");
    el.className = "plug-line";
    el.textContent = line;
    row.appendChild(el);
  }
  return row;
}

function plugSection(title, rows, empty) {
  const sec = document.createElement("div");
  sec.className = "plug-section";
  const head = document.createElement("h4");
  head.textContent = title;
  sec.appendChild(head);
  if (rows.length) {
    for (const r of rows) sec.appendChild(r);
  } else {
    const el = document.createElement("p");
    el.className = "plug-empty";
    el.textContent = empty;
    sec.appendChild(el);
  }
  return sec;
}

// What one market entry says about the target machine. A version is a claim with
// a content digest hanging off it (`0.1.0+<hex16>`, ui/components.js
// installVersion), so the release is compared before the `+`.
function plugMarketLines(entry) {
  const source = entry.source ? "· " + entry.source : "";
  const lines = [];
  const held = plugState.held ? plugState.held.find((h) => h.name === entry.name) : null;
  if (plugState.held === null) {
    lines.push("on this machine: unknown" + (plugState.heldError ? " (" + plugState.heldError + ")" : ""));
  } else if (!held) {
    lines.push("not installed on this machine");
  } else {
    const own = String(held.version || "");
    const offered = String(entry.version || "");
    const same = own.split("+")[0] === offered;
    lines.push(same ? `installed: ${own}` : `installed: ${own} — this source offers ${offered || "an unnamed version"}`);
  }
  if (entry.published && entry.published.version) {
    // a checkout this client can archive, with the release under it: the release
    // is what a machine that already holds the checkout can still receive
    lines.push(`release under it: ${entry.published.version} · ${entry.published.source}`);
  }
  if (source) lines.push(source.trim());
  return lines;
}

function plugHeldSection() {
  if (plugState.held === null) {
    return plugSection(
      "On this machine",
      [],
      plugState.heldError ? "could not be read — " + plugState.heldError : "reading…"
    );
  }
  const offered = new Set((plugState.market ? plugState.market.entries : []).map((e) => e.name));
  const rows = plugState.held.map((h) => {
    const chips = [];
    if (h.interface) chips.push([h.interface, ""]);
    if (h.version) chips.push([h.version, "mono"]);
    if (plugState.market && !offered.has(h.name)) chips.push(["not offered by this client", "warn"]);
    const digest = String(h.digest || "");
    return plugRow(h.name, chips, [digest ? "digest " + digest.slice(0, 16) : ""]);
  });
  return plugSection(`On this machine (${plugState.held.length})`, rows, "no component installed");
}

// The install control for one market row. The label is derived from what the
// target already holds, so pressing it is never a surprise: a version the
// machine already carries says "Reinstall" (the same bytes are rewritten), and
// while any install runs every button is dead — one write at a time, and the
// page can always name which one.
function plugInstallButton(entry) {
  const held = plugState.held ? plugState.held.find((h) => h.name === entry.name) : null;
  const same = Boolean(held) && String(held.version || "").split("+")[0] === String(entry.version || "");
  const busy = plugState.busy && plugState.busy.name === entry.name;
  const btn = document.createElement("button");
  btn.className = "plug-install";
  btn.type = "button";
  btn.textContent = busy ? "…" : same ? "Reinstall" : "Install";
  if (!plugState.target) {
    btn.disabled = true;
    // the target is unresolvable (the read is still running, or it failed):
    // which machine would receive the bytes is exactly what must not be guessed
    btn.title = "the target machine has not been read yet — nothing may be sent before it is";
  } else if (!plugState.target.base) {
    // a tunnel with no supervisor URL is no machine yet: no button may imply a write
    btn.disabled = true;
    btn.title = "no supervisor URL for the target machine yet";
  } else if (plugState.busy) {
    btn.disabled = true;
    btn.title = plugState.busy.name + " is being installed";
  } else if (same) {
    btn.title = `this machine already holds ${entry.name} ${held.version}`;
  } else if (plugState.held === null) {
    btn.title = "what this machine holds could not be read; the host still decides";
  } else {
    btn.title = `install ${entry.name} on ${plugTargetName(plugState.target)}`;
  }
  btn.addEventListener("click", () => plugInstall(entry));
  return btn;
}

// Where an in-flight install is, in words the user can act on: the two slow
// steps differ in kind (building bytes off a local checkout vs sending them over
// the tunnel), and the two host verdicts differ in what they cost.
function plugStageLine(busy) {
  const where = plugTargetName(plugState.target);
  switch (busy.stage) {
    case "artifact":
      return `preparing the bytes for ${busy.name}…`;
    case "upload":
      return `sending ${busy.name} ${busy.version || ""} to ${where}…`.replace("  ", " ");
    case "current":
      return `${busy.name} is already current on ${where} — nothing was sent`;
    case "installed":
      return `${busy.name} landed on ${where}`;
    default:
      return `installing ${busy.name} on ${where}…`;
  }
}

// The host's verdict, in the host's words: it is the side that weights the bytes
// against the declaration's digest, refuses a schema it cannot read, and decides
// whether it needed them at all. A refusal here is quoted, not paraphrased.
function plugInstallResult(entry, res, where) {
  if (!res || !res.ok) {
    return { ok: false, text: `could not install ${entry.name} on ${where} — ${(res && res.error) || "no answer"}` };
  }
  if (res.status === "current") {
    return { ok: true, text: `${entry.name} was already current (${res.version}) on ${where} — nothing was sent` };
  }
  const path = res.path ? " · " + res.path : "";
  return { ok: true, text: `installed ${entry.name} ${res.version} on ${where}${path}` };
}

// Ask, then write. The question names the machine and states the one fact the
// page must not hide (the write cannot be undone from here), and the answer is
// either an install that was actually started or nothing at all.
async function plugInstall(entry) {
  const api = window.clutchComponents;
  if (!api || plugState.busy || !plugState.target || !plugState.target.base) return;
  const where = plugTargetName(plugState.target);
  const held = plugState.held ? plugState.held.find((h) => h.name === entry.name) : null;
  const knows = plugState.held === null ? " Whether this machine already holds it could not be read." : "";
  const again = held ? ` It already holds ${held.version}; installing rewrites that same version.` : "";
  const go = await askConfirm({
    title: `Install ${entry.name}?`,
    text:
      `${entry.name}${entry.version ? " " + entry.version : ""} is written into ${where}'s component directory.` +
      " This page cannot undo that: nothing in this app can remove an installed component yet." +
      again +
      knows,
    ok: "Install",
  });
  if (!go) return;
  plugState.busy = { name: entry.name, stage: "starting" };
  plugState.result = null;
  renderPlugins();
  let res;
  try {
    res = await api.install(entry.name);
  } catch (e) {
    // the IPC hop itself failed (window gone, main process gone): still the
    // failure path, not a silent no-op
    res = { ok: false, name: entry.name, error: (e && e.message) || String(e) };
  }
  plugState.busy = null;
  plugState.result = plugInstallResult(entry, res, where);
  renderPlugins();
  // the machine's inventory just changed: read it back. The market is cached
  // (ui/components-view.js MARKET_TTL_MS), so this is one local HTTP call, not a
  // second pass over the network.
  if (res && res.ok) plugRead();
}

function plugMarketSection() {
  if (!plugState.market) {
    return plugSection(
      "Market",
      [],
      plugState.marketError ? "could not be read — " + plugState.marketError : "reading the sources this build knows…"
    );
  }
  const rows = plugState.market.entries.map((e) => {
    const chips = [];
    if (e.interface) chips.push([e.interface, ""]);
    chips.push([e.version || "no version", "mono"]);
    chips.push([e.origin, e.origin === "checkout" ? "accent" : ""]);
    return plugRow(e.name, chips, plugMarketLines(e), [plugInstallButton(e)]);
  });
  const sec = plugSection(
    `Market (${plugState.market.entries.length} of ${plugState.market.sources} source(s))`,
    rows,
    "no component is known to this client"
  );
  if (plugState.market.entries.length) {
    const caution = document.createElement("p");
    caution.className = "plug-caution";
    caution.textContent = "install writes files on the target machine — nothing in this app can take an installed component back yet";
    sec.appendChild(caution);
  }
  // a source that did not answer explains a short market: one line each, in the
  // section it shortened
  for (const reason of plugState.market.errors) {
    const el = document.createElement("p");
    el.className = "plug-source-error";
    el.textContent = reason;
    sec.appendChild(el);
  }
  return sec;
}

function renderPlugins() {
  plugBodyEl.innerHTML = ""; // full redraw: two short lists, one state object
  plugTargetEl.textContent = plugTargetName(plugState.target);
  plugBaseEl.textContent = plugState.target && plugState.target.base ? plugState.target.base : "";
  // one line, in order of what the user needs to know right now: a write in
  // flight outranks its own outcome, which outranks a read that failed, which
  // outranks a read still running
  const problem = plugState.heldError || plugState.marketError;
  let note = "";
  let bad = false;
  if (plugState.busy) {
    note = plugStageLine(plugState.busy);
  } else if (plugState.result) {
    note = plugState.result.text;
    bad = !plugState.result.ok;
  } else if (problem) {
    note = problem;
    bad = true;
  } else if (plugState.pending) {
    note = "reading…";
  }
  plugNoteEl.className = "plug-note" + (bad ? " error" : "");
  plugNoteEl.textContent = note;
  if (!window.clutchComponents) {
    plugNoteEl.className = "plug-note error";
    plugNoteEl.textContent = "this shell has no component channel";
    return;
  }
  plugBodyEl.appendChild(plugHeldSection());
  plugBodyEl.appendChild(plugMarketSection());
}

// Read both halves, render each as it lands: the machine's own inventory is one
// local HTTP call, the market is one per source (a release manifest, and every
// source is a network hop that can take its time).
function plugRead({ force = false } = {}) {
  const api = window.clutchComponents;
  if (!api || plugState.pending) return; // no channel, or a read already running
  plugState.heldError = null;
  plugState.marketError = null;
  plugState.pending = 2;
  renderPlugins();
  api
    .list()
    .then((r) => {
      plugState.target = r.target;
      // a machine that could not be read is NOT a machine holding nothing: the
      // empty list is what the read leaves behind on failure, and drawing it as
      // "no component installed" is exactly the reading this page must not give
      plugState.held = r.error ? null : r.held;
      plugState.heldError = r.error;
    })
    .catch((e) => {
      plugState.heldError = (e && e.message) || String(e);
    })
    .then(() => {
      plugState.pending--;
      renderPlugins();
    });
  api
    .market({ force })
    .then((m) => {
      plugState.market = m;
    })
    .catch((e) => {
      plugState.marketError = (e && e.message) || String(e);
    })
    .then(() => {
      plugState.pending--;
      renderPlugins();
    });
}

plugReloadBtn.addEventListener("click", () => {
  plugState.result = null; // a reload is a request for facts, not a report to keep
  plugRead({ force: true });
});
// the tab is the entry point: opening it is what makes the page go and look
$("#settings-tab-plugins").addEventListener("click", () => pluginTabShown());

function pluginTabShown() {
  plugRead();
}

// The install runs in the main process (it holds the filesystem and the network);
// the stages come back as they happen, so a slow tunnel does not look like a
// frozen button. A stage for anything but the install this page started is
// ignored — this page is not the only window.
if (window.clutchComponents && window.clutchComponents.onProgress) {
  window.clutchComponents.onProgress((stage) => {
    if (!stage || !plugState.busy || stage.name !== plugState.busy.name) return;
    plugState.busy = { name: stage.name, stage: stage.stage, version: stage.version };
    renderPlugins();
  });
}
