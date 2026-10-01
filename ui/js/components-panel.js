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
// Three writes this page can perform, offered according to what each one costs
// (PLUGIN_PLAN.md I5). Every button names WHICH machine it acts on, the
// confirmations say what the act actually costs (an install writes bytes over
// whatever version is there; a removal DELETES them — neither is a rollback,
// because nothing here keeps a copy of what it replaces or takes away), and the
// outcome is always the host's own verdict, quoted. The switch is the one write
// that touches no bytes and is reversible from the very control that asks for
// it, so it asks nothing: teaching the user to click through a confirmation on a
// free, undoable act is how they learn to click through the two that are neither.
// A read that failed never becomes an offer to write: an unreachable target
// disables the controls instead of pretending the write will land.
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
  busy: null, // {name, verb, stage} — a write in flight, nothing else may start
  result: null, // {ok, text} — the host's verdict on the last write
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
    // "held" and "driven" are two different facts, and the machine's registry
    // keeps them apart: a stopped component is still here, still listed, and its
    // bytes are untouched — only its tools are withheld. The chip states that
    // instead of leaving the user to infer it from the button's label.
    if (h.disabled) chips.push(["stopped", "warn"]);
    if (plugState.market && !offered.has(h.name)) chips.push(["not offered by this client", "warn"]);
    const digest = String(h.digest || "");
    const lines = [digest ? "digest " + digest.slice(0, 16) : ""];
    if (h.disabled) lines.push("held on this machine, but not driven: its tools are not offered here");
    return plugRow(h.name, chips, lines, [plugSwitchButton(h), plugRemoveButton(h)]);
  });
  return plugSection(`On this machine (${plugState.held.length})`, rows, "no component installed");
}

// What an in-flight write is doing, in one word, for the titles of the controls
// that are dead behind it. All four verbs share one `busy`, so a control that
// says the wrong one would send the user after the wrong act: an install carries
// no verb (it is the default write), and the two directions of the switch differ
// in what they do, so neither is spelled as the other.
function plugBusyWord(busy) {
  if (busy.verb === "remove") return "being removed";
  if (busy.verb === "disable") return "being stopped";
  if (busy.verb === "enable") return "being driven again";
  return "being installed";
}

// The switch: stop the machine DRIVING one component it holds, or start again.
// It lives on the held row because that is the row whose fact it changes, and it
// is offered with the least ceremony of the three writes — it deletes nothing and
// its own label is the undo, so there is no question to ask. What it must still
// say is what the user cannot see: which machine is being switched, and that the
// bytes are not what moves.
function plugSwitchButton(held) {
  const busy = plugState.busy && plugState.busy.name === held.name;
  const stopped = Boolean(held.disabled);
  const btn = document.createElement("button");
  btn.className = "plug-switch" + (stopped ? " stopped" : "");
  btn.type = "button";
  btn.textContent = busy ? "…" : stopped ? "Enable" : "Disable";
  if (!plugState.target || !plugState.target.base) {
    btn.disabled = true;
    btn.title = "no supervisor URL for the target machine yet";
  } else if (!window.clutchComponents || !window.clutchComponents.setDisabled) {
    // a shell without the verb must not draw a control that looks like one
    btn.disabled = true;
    btn.title = "this shell cannot switch components on a machine";
  } else if (plugState.busy) {
    btn.disabled = true;
    btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
  } else if (stopped) {
    btn.title = `drive ${held.name} on ${plugTargetName(plugState.target)} again — its bytes stay where they are`;
  } else {
    btn.title =
      `stop ${plugTargetName(plugState.target)} driving ${held.name} — it stays installed and listed, ` +
      "its tools are no longer offered, and nothing is deleted";
  }
  btn.addEventListener("click", () => plugSwitch(held));
  return btn;
}

// The reverse verb for one installed component: the row IS the thing that can
// go, so the control lives beside it and names it. Same discipline as the
// install control — it is dead while the machine is unknown (which machine would
// lose the bytes is exactly what must not be guessed) and while any write is in
// flight, and its title says what it would take off where.
function plugRemoveButton(held) {
  const busy = plugState.busy && plugState.busy.name === held.name;
  const btn = document.createElement("button");
  btn.className = "plug-remove";
  btn.type = "button";
  btn.textContent = busy ? "…" : "Remove";
  if (!plugState.target || !plugState.target.base) {
    btn.disabled = true;
    btn.title = "no supervisor URL for the target machine yet";
  } else if (plugState.busy) {
    btn.disabled = true;
    btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
  } else {
    const version = held.version ? " " + held.version : "";
    btn.title = `remove ${held.name}${version} from ${plugTargetName(plugState.target)}`;
  }
  btn.addEventListener("click", () => plugRemove(held));
  return btn;
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
    btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
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
  if (busy.verb === "remove") return `removing ${busy.name} from ${where}…`;
  // the switch is the one write with no bytes to build or send: it has one stage
  // and one machine, and the sentence says which way it is going
  if (busy.verb === "disable") return `stopping ${busy.name} on ${where}…`;
  if (busy.verb === "enable") return `driving ${busy.name} on ${where} again…`;
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

// The host's verdict on a removal, in the host's words. Three outcomes, and
// only one of them is a failure: "removed" names the versions that went,
// "absent" says there was nothing to take (the request was already true — a
// problem report here would invent one), and a refusal is quoted.
function plugRemoveResult(held, res, where) {
  if (!res || !res.ok) {
    return { ok: false, text: `could not remove ${held.name} from ${where} — ${(res && res.error) || "no answer"}` };
  }
  if (res.status === "absent") {
    return { ok: true, text: `${held.name} was not installed on ${where} — there was nothing to remove` };
  }
  const went = res.removed && res.removed.length ? " " + res.removed.join(", ") : "";
  return { ok: true, text: `removed ${held.name}${went} from ${where}` };
}

// The host's verdict on the switch, in the host's words. Nothing is destroyed
// here, so there is no cost to recite — but one fact must not be blurred: a
// stopped component is still HELD, its bytes are where they were, its row stays
// on this page, and the only thing that changed is whether this machine offers
// its tools. "absent" is an ANSWER, not a failure: the request was already true
// on that machine, so there was nothing there to stop or start — which usually
// means the switch was aimed at a machine that does not hold the component at
// all, and the page has to say so instead of reporting a phantom success.
function plugSwitchResult(held, res, where) {
  if (!res || !res.ok) {
    return { ok: false, text: `could not switch ${held.name} on ${where} — ${(res && res.error) || "no answer"}` };
  }
  if (res.status === "absent") {
    return { ok: true, text: `${held.name} is not held by ${where} — there was nothing to stop or start` };
  }
  // the host's bit when it sent one; otherwise the state that was asked for
  const now = typeof res.disabled === "boolean" ? res.disabled : !held.disabled;
  return {
    ok: true,
    text: now
      ? `stopped driving ${held.name} on ${where} — it is still held there, its tools are no longer offered`
      : `driving ${held.name} on ${where} again — its tools are offered once more`,
  };
}

// Ask, then delete. The question is the same shape as the install's and says the
// harder thing: these bytes are DELETED, and this page keeps no copy to put back.
async function plugRemove(held) {
  const api = window.clutchComponents;
  if (!api || !api.remove || plugState.busy || !plugState.target || !plugState.target.base) return;
  const where = plugTargetName(plugState.target);
  const version = held.version ? " " + held.version : "";
  const go = await askConfirm({
    title: `Remove ${held.name}?`,
    text:
      `${held.name}${version} is deleted from ${where}'s component directory, together with any other version of it that machine holds.` +
      " This cannot be undone from here: nothing in this app keeps a copy of what it removes," +
      " so putting it back means installing it again from a source.",
    ok: "Remove",
  });
  if (!go) return;
  plugState.busy = { name: held.name, verb: "remove", stage: "removing" };
  plugState.result = null;
  renderPlugins();
  let res;
  try {
    res = await api.remove(held.name);
  } catch (e) {
    // the IPC hop itself failed: still the failure path, still with a reason
    res = { ok: false, name: held.name, error: (e && e.message) || String(e) };
  }
  plugState.busy = null;
  plugState.result = plugRemoveResult(held, res, where);
  renderPlugins();
  // the machine's inventory just changed: read both halves back (the counts and
  // the rows), exactly as an install does
  if (res && res.ok) plugRead();
}

// Send the state being asked for, then let the host answer. What goes on the
// wire is the state (`disabled` true = held, not driven), never a verb: the host
// stores a bit, and a page that sent "toggle" would be asking the machine to
// guess what this one believed. No question is asked — this write destroys
// nothing, and the control's own label is the way back — but the page still says
// what it is doing and then quotes the host, including the "absent" answer.
async function plugSwitch(held) {
  const api = window.clutchComponents;
  if (!api || !api.setDisabled || plugState.busy || !plugState.target || !plugState.target.base) return;
  const where = plugTargetName(plugState.target);
  const disabled = !held.disabled; // the state being asked for, not the one it is in
  plugState.busy = { name: held.name, verb: disabled ? "disable" : "enable", stage: "starting" };
  plugState.result = null;
  renderPlugins();
  let res;
  try {
    res = await api.setDisabled(held.name, disabled);
  } catch (e) {
    // the IPC hop itself failed: still the failure path, still with a reason
    res = { ok: false, name: held.name, error: (e && e.message) || String(e) };
  }
  plugState.busy = null;
  plugState.result = plugSwitchResult(held, res, where);
  renderPlugins();
  // what this machine offers just changed: read the inventory back, so the row
  // that was stopped is drawn as stopped rather than as it was a moment ago
  if (res && res.ok) plugRead();
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
      " It can be removed again from this page, but a removal DELETES bytes: nothing here keeps a copy," +
      " so neither act is a rollback." +
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
    caution.textContent = "install writes files on the target machine and Remove deletes them — neither is a rollback: nothing here keeps a copy of what it replaces or takes away (the switch on the rows above is the third write: it deletes nothing, and pressing it again is the undo)";
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
