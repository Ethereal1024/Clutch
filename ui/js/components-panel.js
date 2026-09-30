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
// This file installs nothing (PLUGIN_PLAN.md I5: a page that cannot undo a write
// does not offer it). It reads, and says what it read.
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
function plugRow(name, chips, lines) {
  const row = document.createElement("div");
  row.className = "plug-row";
  const head = document.createElement("div");
  head.className = "plug-row-head";
  const nameEl = document.createElement("span");
  nameEl.className = "plug-name";
  nameEl.textContent = name;
  head.appendChild(nameEl);
  for (const [text, cls] of chips) head.appendChild(plugChip(text, cls));
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
    return plugRow(e.name, chips, plugMarketLines(e));
  });
  const sec = plugSection(
    `Market (${plugState.market.entries.length} of ${plugState.market.sources} source(s))`,
    rows,
    "no component is known to this client"
  );
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
  const problem = plugState.heldError || plugState.marketError;
  plugNoteEl.className = "plug-note" + (problem ? " error" : "");
  plugNoteEl.textContent = problem || (plugState.pending ? "reading…" : "");
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

plugReloadBtn.addEventListener("click", () => plugRead({ force: true }));
// the tab is the entry point: opening it is what makes the page go and look
$("#settings-tab-plugins").addEventListener("click", () => pluginTabShown());

function pluginTabShown() {
  plugRead();
}
