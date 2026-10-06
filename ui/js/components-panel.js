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
const plugFilterEl = $("#plug-filter");
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
  versions: null, // {name, rows, error} — the one open version list, as just read
  versionsPending: null, // name whose version list is being read right now
  versionsSeq: 0, // which version-list read is the current one (closing bumps it)
  filter: "all", // which slice of the ONE list is on screen (never persisted)
  query: "", // the name filter, as typed (never persisted)
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
  // per-window, like every reader of the session URL: localStorage is shared by
  // every window in the process (js/backend-lifecycle.js)
  const connected = sessionStorage.getItem("clutch_api_url") && localStorage.getItem("clutch_ssh_connected");
  const label = host ? `${user ? user + "@" : ""}${host}${port ? ":" + port : ""}` : "the tunneled machine";
  return `SSH ${label}${connected ? " ✓" : ""}`;
}

function plugChip(text, cls) {
  const el = document.createElement("span");
  el.className = "plug-chip" + (cls ? " " + cls : "");
  el.textContent = text;
  return el;
}

// ONE row, in the shape VS Code gives one extension (extensionsList.ts:70-90,
// renderTemplate): a header line — the name, and whatever small state marks belong
// beside it — then ONE line of description, then the row's controls on their own
// line under both, then the thing that belongs UNDER the row (a version list), or
// nothing.
//
// What is deliberately NOT here is the pile of facts a row used to carry: the
// digest, the source path, the "release under it", the offered-versus-held
// version. That is metadata about the component, not the row's business, and VS
// Code puts exactly that material one click away (the extension editor) instead of
// in the list (extensionsList.ts:167-170 gives the description line `.ellipsis`,
// i.e. one line, cut short; the version/rating counts beside the name are the only
// numbers the row shows). Here it goes on the row's own `title=`, which is the one
// place a summary can be complete without being drawn — and into the Versions
// disclosure, which is the machine's own answer, not ours.
//
// `desc` is the row's one sentence (`plugItemDesc`), drawn in a quieter voice and
// cut to one line; a row that names a version instead of a component (a version
// row inside the Versions disclosure) passes `lines` and gets them under the name
// as before — a version's digest and path ARE that row's own facts.
//
// `state` is what is happening to THIS row right now — a write in flight or the
// host's verdict on the last one — and it is drawn here rather than in the page's
// note line, because a status with no row in it belongs to no component: the user
// has to find which of ten rows the sentence is about. It may also colour the row
// itself (`state.row`), which is how "this machine holds it but is not driving
// it" is said without a second block of text (VS Code: `.disabled` on the row,
// extensionsList.ts:185-191).
function plugRow(name, { chips = [], desc = "", lines = [], actions = [], extra = null, state = null, title = "" } = {}) {
  const row = document.createElement("div");
  row.className = "plug-row" + (state && state.row ? " " + state.row : "");
  if (title) row.title = title;
  const head = document.createElement("div");
  head.className = "plug-row-head";
  const nameEl = document.createElement("span");
  nameEl.className = "plug-name";
  nameEl.textContent = name;
  head.appendChild(nameEl);
  for (const [text, cls] of chips) head.appendChild(plugChip(text, cls));
  row.appendChild(head);
  if (state && state.text) {
    const el = document.createElement("div");
    el.className = "plug-line plug-state" + (state.cls ? " " + state.cls : "");
    el.textContent = state.text;
    row.appendChild(el);
  }
  if (desc) {
    const el = document.createElement("div");
    el.className = "plug-row-desc";
    el.textContent = desc;
    row.appendChild(el);
  }
  for (const line of lines) {
    if (!line) continue;
    const el = document.createElement("div");
    el.className = "plug-line";
    el.textContent = line;
    row.appendChild(el);
  }
  // the controls get their OWN line, right-aligned under the sentence — VS Code's
  // row is exactly this (`.details` = `.header-container` -> `.description` ->
  // `.footer`, media/extension.css, and the footer is the ActionBar). Beside the
  // name they would fight it for width on a phone, and the name is the one thing
  // on the row that must never be the part that gives way.
  if (actions.length) {
    const foot = document.createElement("div");
    foot.className = "plug-row-actions";
    for (const a of actions) foot.appendChild(a);
    row.appendChild(foot);
  }
  if (extra) row.appendChild(extra);
  return row;
}

function plugSection(title, meta, rows, empty) {
  const sec = document.createElement("div");
  sec.className = "plug-section";
  const head = document.createElement("h4");
  head.textContent = title;
  if (meta) {
    // the title is the MACHINE; the counts are what is behind it
    const el = document.createElement("span");
    el.className = "plug-meta";
    el.textContent = meta;
    head.appendChild(el);
  }
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

// The whole list model, and the reason there is only one list: the machine's
// inventory and the market this client knows are joined BY NAME, so a component
// that is both held and offered is ONE row. The user never lines up two sections
// to learn whether something is installed (PLUGIN_UI_PLAN.md, "the panel is about
// exactly one machine").
function plugModel() {
  const byName = new Map();
  const order = [];
  const slot = (name) => {
    if (!byName.has(name)) {
      byName.set(name, { name, entry: null, held: null });
      order.push(name);
    }
    return byName.get(name);
  };
  // the client's known set first (that is the order a user scans), then anything
  // the machine holds that no source this client reads offers
  for (const e of plugState.market ? plugState.market.entries : []) slot(e.name).entry = e;
  for (const h of plugState.held || []) slot(h.name).held = h;
  return order.map((n) => byName.get(n));
}

// The five views of the ONE list. A view is a way of LOOKING at what the machine
// holds and what this client knows, not a fact about either: nothing here is
// asked of the host, and nothing here is written down (a filter that survived a
// reload would be a second copy of a state the page does not own).
const PLUG_FILTERS = [
  ["all", "All"],
  ["installed", "Installed"],
  ["market", "Market"],
  ["updates", "Updates"],
  ["stopped", "Stopped"],
];

// "held here, and this client carries a DIFFERENT release for it." The release is
// compared before the `+`, like everywhere else on this page: the build id after
// it differs per machine, and calling that an update would be wrong.
function plugItemUpdate(item) {
  if (!item.held || !item.entry) return false;
  const offered = String(item.entry.version || "");
  return Boolean(offered) && String(item.held.version || "").split("+")[0] !== offered;
}

// Whether one component belongs to one view. Kept apart from the name query
// below because the chips COUNT by this rule: a chip's number is how much that
// view holds, not how much of it the box above is currently spelling out.
function plugItemMatches(item, filter) {
  switch (filter) {
    case "installed":
      return Boolean(item.held);
    case "market":
      return Boolean(item.entry);
    case "updates":
      return plugItemUpdate(item);
    case "stopped":
      return Boolean(item.held && item.held.disabled);
    default:
      return true;
  }
}

function plugItemShown(item) {
  const q = plugState.query.trim().toLowerCase();
  if (q && !String(item.name).toLowerCase().includes(q)) return false;
  return plugItemMatches(item, plugState.filter);
}

// The filter row: one chip per view, plus a box that filters by name. It is built
// ONCE and only its state is redrawn — rebuilding it on every read would take the
// caret out of the box while it is being typed in, which is the one thing a
// filter may never do.
let plugFilterChips = null;

function plugFilterRow() {
  if (plugFilterChips) return plugFilterChips;
  const box = document.createElement("div");
  box.className = "plug-filter-chips";
  plugFilterChips = [];
  for (const [id, label] of PLUG_FILTERS) {
    const btn = document.createElement("button");
    btn.className = "plug-filter-chip";
    btn.type = "button";
    btn.textContent = label;
    btn.title = `show only ${label.toLowerCase()} of what this machine holds and this client knows`;
    // the count sits beside the label, in the same voice as the title's counts:
    // "Updates 2" is a reason to click, "Updates" alone is not
    const count = document.createElement("span");
    count.className = "plug-filter-count";
    btn.appendChild(count);
    btn.addEventListener("click", () => {
      plugState.filter = id;
      renderPlugins();
    });
    plugFilterChips.push([id, btn, count]);
    box.appendChild(btn);
  }
  const input = document.createElement("input");
  input.className = "plug-filter-name";
  input.type = "text";
  input.value = plugState.query;
  input.placeholder = "filter by name";
  input.title = "filter by name";
  input.addEventListener("input", () => {
    plugState.query = input.value || "";
    renderPlugins();
  });
  plugFilterEl.appendChild(box);
  plugFilterEl.appendChild(input);
  return plugFilterChips;
}

function plugDrawFilter() {
  const items = plugModel();
  for (const [id, btn, count] of plugFilterRow()) {
    btn.classList.toggle("active", id === plugState.filter);
    const n = items.filter((item) => plugItemMatches(item, id)).length;
    // a zero is not a number worth reading on a chip: the empty message under it
    // already says why nothing is there
    count.textContent = n ? " " + n : "";
  }
}

// One row's chips. VS Code's header carries only state marks beside the name
// (restart-required, sync-ignored, install count — extensionsList.ts:81-87), never
// the version: a version is what the component's own page is for. The one fact
// that has no other landing place on this page is "stopped", because "held but not
// driven" is a state of the ROW, and the row says it in colour, in this chip, and
// in its own sentence (`plugItemDesc`).
function plugItemChips(item) {
  const chips = [];
  if (item.held && item.held.disabled) chips.push(["stopped", "warn"]);
  return chips;
}

// The row's ONE line: what this component's relationship to the target machine is,
// in one sentence. VS Code's list gives the description line the same job — one
// line, cut short (`extensionsList.ts:167-170`, `.description.ellipsis`) — and it
// is the row's only prose because everything else a row could say (digest, source,
// path, the versions it holds) is either the machine's own answer in the Versions
// disclosure or one of the facts below.
function plugItemDesc(item) {
  const held = item.held;
  const entry = item.entry;
  if (held && held.disabled) return "held on this machine, but not driven: its tools are not offered here";
  if (held && entry) {
    return plugItemUpdate(item)
      ? `installed — this client offers ${entry.version || "another version"}`
      : "installed — nothing newer is offered here";
  }
  if (held) return "installed — no source this client reads offers it";
  if (entry && plugState.held === null) {
    // the machine could not be read at all: "unknown" is a fact, not an empty list
    return "on this machine: unknown";
  }
  return "not installed here";
}

// The facts that answer "what exactly is this row about", for the row's `title=`
// (U-10: the fold VS Code achieves with the extension editor). Same material the
// row used to draw as lines, minus the prose — a tooltip is read by someone who
// already asked, so it may be dense. A version is a claim with a content digest
// hanging off it (`0.1.0+<hex16>`, ui/components.js installVersion), which is why
// the release is compared before the `+` everywhere on this page.
function plugItemMeta(item) {
  const meta = [];
  const held = item.held;
  const entry = item.entry;
  if (held) {
    meta.push("held " + (held.version || "at an unnamed version"));
    if (held.digest) meta.push("digest " + String(held.digest).slice(0, 16));
    if (held.disabled) meta.push("stopped");
    if (held.interface) meta.push(held.interface);
  } else if (plugState.held === null && plugState.heldError) {
    meta.push("what this machine holds could not be read: " + plugState.heldError);
  }
  if (entry) {
    meta.push(`offered ${entry.version || "at an unnamed version"} (${entry.origin}${entry.interface ? ", " + entry.interface : ""})`);
    if (entry.published && entry.published.version) {
      // a checkout this client can archive, with the release under it: the release
      // is what a machine that already holds the checkout can still receive
      meta.push(`release under it: ${entry.published.version} · ${entry.published.source}`);
    }
    if (entry.source) meta.push(entry.source);
  }
  return meta;
}

// Which write a row LEADS with, in VS Code's own order of precedence. Installed is
// the pivot: `InstallAction.computeAndUpdateEnablement()` hides the Install action
// outright once the extension is installed (`extensionsActions.ts:472-500` — the
// button is not drawn, it is not drawn grey), and what is left on an installed
// extension is the Update action when the gallery is newer
// (`UpdateAction.computeAndUpdateEnablement()`, `:990-1010`) and the switch (Enable
// / Disable, in the Manage menu, `ManageExtensionAction.getActionGroups()`,
// `:1371-1405`) otherwise. Nothing else about the row is expressed by its lead
// button: a component this client can offer leads with the write that puts it on
// the machine, and only the machine holds it -> the switch.
function plugItemLead(item) {
  if (item.entry && !item.held) return "install";
  if (item.held && item.entry && plugItemUpdate(item)) return "update";
  if (item.held) return "switch";
  return null;
}

// The controls on one row: ONE leading write, then ONE "…" holding everything else
// that row can do, drawn and disabled exactly as it would be on the row — out of
// the way, never absent (a control that is only shown on a click is a control the
// page cannot be asked about). The lead follows `plugItemLead`; the menu keeps VS
// Code's own grouping order (ManageExtensionAction: the enable/disable group, then
// the install-family one, then the removal).
function plugItemActions(item) {
  const lead = plugItemLead(item);
  const actions = [];
  const primary =
    lead === "install" || lead === "update"
      ? item.entry
        ? plugInstallButton(item.entry)
        : null
      : lead === "switch" && item.held
        ? plugSwitchButton(item.held)
        : null;
  if (primary) actions.push(primary);
  const secondary = plugItemMenuItems(item, lead);
  if (secondary.length) {
    const menu = plugMenu(secondary);
    actions.push(plugMoreButton(item.name, menu), menu);
  }
  return actions;
}

// What the row can do BESIDE that write, in the order it is offered: the switch
// (unless the switch IS what the row leads with), then the write this client can
// still make (the same release again — the "Reinstall" an installed component
// keeps in its menu, the way VS Code keeps "Install Another Version…" in the
// Manage menu, extensionsActions.ts:1338-1405), then the versions the machine
// holds, then the removal, which is the one write that DELETES and is exactly why
// it is never the button a row leads with (PLUGIN_PLAN.md I5). The comparison is
// by KIND and not by node: the items are built here, so identity would say
// "different" about two buttons that are the same control.
function plugItemMenuItems(item, lead) {
  const items = [];
  if (!item.held) return items; // a component this machine does not hold has nothing else to offer
  if (lead !== "switch") items.push(plugSwitchButton(item.held));
  if (item.entry && lead !== "install" && lead !== "update") items.push(plugInstallButton(item.entry));
  items.push(plugVersionsButton(item.held), plugRemoveButton(item.held));
  return items;
}

// One menu: its items are drawn once and shown by a class, so opening it builds
// nothing and closing it loses nothing. A redraw takes the class away with the
// row, which is why this page keeps no copy of "which menu is open".
function plugMenu(items) {
  const box = document.createElement("span");
  box.className = "plug-menu";
  for (const item of items) box.appendChild(item);
  return box;
}

// The "…" itself: never a write, so it is live whenever the row is, and its title
// says the two things its label cannot — which component, and on which machine.
function plugMoreButton(name, menu) {
  const btn = document.createElement("button");
  btn.className = "plug-more";
  btn.type = "button";
  btn.textContent = "…";
  btn.title = `everything else ${name} can do on ${plugTargetName(plugState.target)}`;
  btn.addEventListener("click", (ev) => {
    // the document handler below closes every menu on any click, this one
    // included: the click on the "…" must not reach it (js/settings.js does the
    // same for its dropdowns). What it opens is decided before that, so pressing
    // the "…" of an open menu shuts it instead of re-opening it.
    if (ev && ev.stopPropagation) ev.stopPropagation();
    const open = !menu.classList.contains("open");
    plugCloseMenus();
    // which way it opens is a question about the BOX the row lives in, not about
    // the row: the list is a region with a bottom edge (the modal no longer grows
    // to fit it), and a menu drawn past that edge is one the hand cannot reach.
    menu.classList.toggle("drop-up", open && !plugMenuFitsBelow(btn, menu));
    menu.classList.toggle("open", open);
  });
  return btn;
}

// Whether the menu can be drawn below the control that opened it, measured against
// the list's own bottom edge rather than guessed. VS Code measures too: its
// extension widgets pick the direction from the space the viewport leaves
// (extensionsWidgets.ts). Where there is no layout to measure — the panel's own
// test runner draws into a hand-rolled mini-DOM — the plain downward menu is the
// answer, because that is the one the CSS gives without help.
function plugMenuFitsBelow(btn, menu) {
  if (typeof btn.getBoundingClientRect !== "function") return true;
  if (typeof plugBodyEl.getBoundingClientRect !== "function") return true;
  const anchor = btn.getBoundingClientRect();
  const box = plugBodyEl.getBoundingClientRect();
  // a closed menu has no height: fall back to what three items and their padding
  // take, which is what the menu holds when it is worth opening at all
  const need = (typeof menu.getBoundingClientRect === "function" && menu.getBoundingClientRect().height) || 140;
  return anchor.bottom + need + 8 <= box.bottom;
}

// One menu at a time, and a click anywhere else closes it. Nothing is kept here:
// the class IS the state, and a redraw takes it away with the row it belongs to.
// Guarded because the panel is also driven by a hand-rolled mini-DOM in its own
// test runner, which has no querySelectorAll.
function plugCloseMenus() {
  if (typeof plugBodyEl.querySelectorAll !== "function") return;
  for (const el of plugBodyEl.querySelectorAll(".plug-menu.open")) {
    el.classList.remove("open");
    el.classList.remove("drop-up");
  }
}
document.addEventListener("click", () => plugCloseMenus());

function plugItemRow(item) {
  return plugRow(item.name, {
    chips: plugItemChips(item),
    desc: plugItemDesc(item),
    actions: plugItemActions(item),
    extra: item.held ? plugVersionRows(item.held) : null,
    state: plugItemState(item),
    // every fact the row no longer DRAWS is still answered, one hover away: the
    // list is for choosing, the tooltip for confirming (U-10)
    title: plugItemMeta(item).join(" · "),
  });
}

// The one row's own state line, and the reason the page's note line is no longer
// where a write is reported. Two facts can be said here, and only about this
// component: a write in flight (the stage, in the same words the note used to
// carry) and the host's verdict on the last write. The verdict outlives the write
// because it is what the user must read before deciding again — but it is still
// the ROW's, so a row that goes away (its bytes were removed, a filter hides it)
// takes the verdict back to the note with it (plugOrphanLine).
//
// A stopped row is coloured here too: "held, not driven" is a state of the row,
// not a sentence about it.
function plugItemState(item) {
  const row = [];
  if (item.held && item.held.disabled) row.push("stopped");
  if (plugState.busy && plugState.busy.name === item.name) {
    row.push("busy");
    return { text: plugStageLine(plugState.busy), cls: "busy", row: row.join(" ") };
  }
  const result = plugState.result && plugState.result.name === item.name ? plugState.result : null;
  if (result) return { text: result.text, cls: result.ok ? "" : "error", row: row.join(" ") };
  return { text: "", cls: "", row: row.join(" ") };
}

// What "nothing to draw" means here. A machine that could not be read is NOT a
// machine holding nothing: an empty list and an unanswered read must not look
// alike (a failed read is data on this page). And a filter that hides every row
// is a third thing again — the machine does hold components, this view is simply
// not showing them.
function plugEmptyText(known, shown) {
  if (plugState.held === null && plugState.market === null) {
    const why = plugState.heldError || plugState.marketError;
    return why ? "could not be read — " + why : "reading…";
  }
  if (known && !shown) return "no component here matches this filter";
  return "no component is installed on it or known to this client";
}

// The one list. Its title is the MACHINE this window is acting on — not "On this
// machine", which lies the moment the target is the far side of a tunnel — and
// its counts say how much of the list the machine already holds.
function plugList() {
  const items = plugModel();
  const shown = items.filter(plugItemShown);
  const meta = [];
  if (plugState.held !== null) meta.push(`${plugState.held.length} installed`);
  else if (plugState.heldError) meta.push("inventory unreadable");
  if (plugState.market) meta.push(`${plugState.market.entries.length} known`);
  else if (plugState.marketError) meta.push("market unreadable");
  // a filtered list says so: the count behind the title is about the machine,
  // this one about what is on screen
  if (shown.length !== items.length) meta.push(`${shown.length} shown`);
  const sec = plugSection(
    plugTargetName(plugState.target),
    meta.join(" · "),
    shown.map(plugItemRow),
    plugEmptyText(items.length, shown.length)
  );
  if (plugState.market && plugState.market.entries.length) {
    const caution = document.createElement("p");
    caution.className = "plug-caution";
    caution.textContent = "install writes bytes on the target machine and Remove deletes them — neither is a rollback, since nothing here keeps a copy of what it replaces or takes away (the switch is the third write: it deletes nothing, and pressing it again is the undo)";
    sec.appendChild(caution);
  }
  // a source that did not answer explains a short list: one line each, together
  // at the end rather than scattered through the rows it shortened
  for (const reason of (plugState.market && plugState.market.errors) || []) {
    const el = document.createElement("p");
    el.className = "plug-source-error";
    el.textContent = reason;
    sec.appendChild(el);
  }
  return sec;
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

// The disclosure for one held row: what every version of this component looks
// like ON THE MACHINE that holds it. It is a READ, not a write — so it is never
// dead behind a write in flight (the reload is not either), and what it opens is
// the machine's own answer, kept only as long as the block is open: this page
// keeps no second copy of a machine's truth (frozen decision 3).
function plugVersionsButton(held) {
  const open = Boolean(plugState.versions && plugState.versions.name === held.name);
  const reading = plugState.versionsPending === held.name;
  const btn = document.createElement("button");
  btn.className = "plug-versions" + (open ? " open" : "");
  btn.type = "button";
  btn.textContent = reading ? "…" : open ? "Hide versions" : "Versions";
  if (!plugState.target || !plugState.target.base) {
    btn.disabled = true;
    btn.title = "no supervisor URL for the target machine yet";
  } else if (!window.clutchComponents || !window.clutchComponents.versions) {
    // a shell without the verb must not draw a control that looks like one
    btn.disabled = true;
    btn.title = "this shell cannot read the versions a machine holds";
  } else if (reading) {
    btn.disabled = true;
    btn.title = `reading the versions of ${held.name} on ${plugTargetName(plugState.target)}…`;
  } else if (open) {
    btn.title = `close the version list for ${held.name}`;
  } else {
    btn.title =
      `every version of ${held.name} that ${plugTargetName(plugState.target)} holds, newest first — ` +
      "the marked one is what that machine runs";
  }
  btn.addEventListener("click", () => plugVersionsToggle(held));
  return btn;
}

// The version list under one held row, in the HOST's order (newest first, with
// `resolved` marking the one it runs — the page repeats that order and never
// re-sorts it, because which version wins is the host's knowledge). Each version
// is its own row naming ITSELF, so the remove beside it takes exactly that one:
// taking the whole component is a different act and is drawn on the row above.
function plugVersionRows(held) {
  const reading = plugState.versionsPending === held.name;
  const state = plugState.versions;
  if (!reading && !(state && state.name === held.name)) return null;
  const box = document.createElement("div");
  box.className = "plug-versions-box";
  const line = (text) => {
    const el = document.createElement("div");
    el.className = "plug-line";
    el.textContent = text;
    box.appendChild(el);
  };
  if (reading) {
    line("reading the versions this machine holds…");
    return box;
  }
  if (state.error) {
    // a read that failed is a reason, never an empty list: "no versions" and
    // "the machine could not be asked" are not the same fact
    line("could not be read — " + state.error);
    return box;
  }
  if (!state.rows.length) {
    line("no version of it is held here now");
    return box;
  }
  for (const record of state.rows) {
    const version = String(record.version || "no version");
    const chips = [];
    if (record.disabled) chips.push(["stopped", "warn"]);
    chips.push([record.resolved ? "this machine runs it" : "held beside it", record.resolved ? "accent" : ""]);
    const lines = [record.digest ? "digest " + String(record.digest).slice(0, 16) : ""];
    if (record.path) lines.push("at " + record.path);
    box.appendChild(
      plugRow(version, { chips, lines, actions: [plugRemoveOneButton(held, record)] })
    );
  }
  return box;
}

// The removal of ONE version. Same discipline as the whole-component one — dead
// while the machine is unknown or another write is flying, and asking first —
// but its title and its question name the version, because that is the ONLY
// thing it takes: the versions beside it stay. The host still decides what a
// name and version mean (a version not installed is a refusal, not "absent"),
// and its verdict is quoted as usual.
function plugRemoveOneButton(held, record) {
  const version = String(record.version || "");
  const busy = plugState.busy && plugState.busy.name === held.name;
  const btn = document.createElement("button");
  btn.className = "plug-remove plug-remove-one";
  btn.type = "button";
  btn.textContent = busy ? "…" : "Remove";
  if (!plugState.target || !plugState.target.base) {
    btn.disabled = true;
    btn.title = "no supervisor URL for the target machine yet";
  } else if (plugState.busy) {
    btn.disabled = true;
    btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
  } else {
    btn.title = `remove ${held.name} ${version} from ${plugTargetName(plugState.target)} — the versions beside it stay`;
  }
  btn.addEventListener("click", () => plugRemoveVersion(held, record));
  return btn;
}

// The install control for one market row. The label is derived from what the
// target already holds, the way VS Code derives it from the gallery
// (`UpdateAction.computeAndUpdateEnablement()`, extensionsActions.ts:990-1010
// relabels Install to Update when the gallery has a newer version): an offered
// version this machine does not hold under that name installs, a different
// release under a name it DOES hold is an update, and the same release again is a
// reinstall (the same bytes rewritten). While any write runs every button is dead
// — one write at a time, and the page can always name which one.
function plugInstallButton(entry) {
  const held = plugState.held ? plugState.held.find((h) => h.name === entry.name) : null;
  const offered = String(entry.version || "");
  const heldRelease = held ? String(held.version || "").split("+")[0] : "";
  const same = Boolean(held) && heldRelease === offered;
  const newer = Boolean(held) && !same;
  const busy = plugState.busy && plugState.busy.name === entry.name;
  const btn = document.createElement("button");
  btn.className = "plug-install";
  btn.type = "button";
  btn.textContent = busy ? "…" : same ? "Reinstall" : newer ? "Update" : "Install";
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
  } else if (newer) {
    btn.title =
      `put ${entry.name} ${offered} on ${plugTargetName(plugState.target)} — ` +
      `it holds ${held.version} now, and the older one is replaced, not kept`;
  } else if (plugState.held === null) {
    btn.title = "what this machine holds could not be read; the host still decides";
  } else {
    btn.title = `install ${entry.name} on ${plugTargetName(plugState.target)}`;
  }
  btn.addEventListener("click", () => plugInstall(entry));
  return btn;
}

// Where an in-flight install is, in words the user can act on: the two slow
// steps differ in kind (building bytes off a local checkout and sending them over
// the tunnel, vs the target machine fetching its own copy), and the two host
// verdicts differ in what they cost.
function plugStageLine(busy) {
  const where = plugTargetName(plugState.target);
  if (busy.verb === "remove") return `removing ${busy.name}${busy.version ? " " + busy.version : ""} from ${where}…`;
  // the switch is the one write with no bytes to build or send: it has one stage
  // and one machine, and the sentence says which way it is going
  if (busy.verb === "disable") return `stopping ${busy.name} on ${where}…`;
  if (busy.verb === "enable") return `driving ${busy.name} on ${where} again…`;
  switch (busy.stage) {
    case "wake":
      // the machine's supervisor exits when it is idle, so the write that needs it
      // starts it again: this is the slow first start (the binary unpacks), not a
      // step of the install itself
      return `${where} is starting its supervisor…`;
    case "artifact":
      return `preparing the bytes for ${busy.name}…`;
    case "upload":
      return `sending ${busy.name} ${busy.version || ""} to ${where}…`.replace("  ", " ");
    case "fetch":
      // no bytes are in flight from here: the machine that will run the component
      // is getting them from the release, which is why this says so
      return `${where} is fetching ${busy.name} ${busy.version || ""}…`.replace("  ", " ");
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
    return { ok: false, name: entry.name, text: `could not install ${entry.name} on ${where} — ${(res && res.error) || "no answer"}` };
  }
  if (res.status === "current") {
    return { ok: true, name: entry.name, text: `${entry.name} was already current (${res.version}) on ${where} — nothing was sent` };
  }
  const path = res.path ? " · " + res.path : "";
  return { ok: true, name: entry.name, text: `installed ${entry.name} ${res.version} on ${where}${path}` };
}

// The host's verdict on a removal, in the host's words. Three outcomes, and
// only one of them is a failure: "removed" names the versions that went,
// "absent" says there was nothing to take (the request was already true — a
// problem report here would invent one), and a refusal is quoted.
function plugRemoveResult(held, res, where) {
  if (!res || !res.ok) {
    return { ok: false, name: held.name, text: `could not remove ${held.name} from ${where} — ${(res && res.error) || "no answer"}` };
  }
  if (res.status === "absent") {
    return { ok: true, name: held.name, text: `${held.name} was not installed on ${where} — there was nothing to remove` };
  }
  const went = res.removed && res.removed.length ? " " + res.removed.join(", ") : "";
  return { ok: true, name: held.name, text: `removed ${held.name}${went} from ${where}` };
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
    return { ok: false, name: held.name, text: `could not switch ${held.name} on ${where} — ${(res && res.error) || "no answer"}` };
  }
  if (res.status === "absent") {
    return { ok: true, name: held.name, text: `${held.name} is not held by ${where} — there was nothing to stop or start` };
  }
  // the host's bit when it sent one; otherwise the state that was asked for
  const now = typeof res.disabled === "boolean" ? res.disabled : !held.disabled;
  return {
    ok: true,
    name: held.name,
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
  if (res && res.ok) {
    plugRead();
    plugRefreshVersions();
  }
}

// Ask, then delete ONE version. The question names the version, says the ones
// beside it stay, and says the thing this page never hides: these bytes are
// DELETED and nothing here keeps a copy (I5).
async function plugRemoveVersion(held, record) {
  const api = window.clutchComponents;
  if (!api || !api.remove || plugState.busy || !plugState.target || !plugState.target.base) return;
  const where = plugTargetName(plugState.target);
  const version = String(record.version || "");
  const go = await askConfirm({
    title: `Remove ${held.name} ${version}?`,
    text:
      `${held.name} ${version} is deleted from ${where}'s component directory — exactly the version named;` +
      " the versions beside it stay." +
      " This cannot be undone from here: nothing in this app keeps a copy of what it removes," +
      " so putting it back means installing it again from a source.",
    ok: "Remove",
  });
  if (!go) return;
  plugState.busy = { name: held.name, verb: "remove", stage: "removing", version };
  plugState.result = null;
  renderPlugins();
  let res;
  try {
    res = await api.remove(held.name, { version });
  } catch (e) {
    // the IPC hop itself failed: still the failure path, still with a reason
    res = { ok: false, name: held.name, error: (e && e.message) || String(e) };
  }
  plugState.busy = null;
  plugState.result = plugRemoveResult(held, res, where);
  renderPlugins();
  if (res && res.ok) {
    plugRead();
    plugRefreshVersions();
  }
}

// One component's version list, straight from the machine that holds it. A read
// supersedes an older read of the same list, and closing the block bumps the
// sequence: a late answer must never reopen what the user closed.
function plugReadVersions(name) {
  const api = window.clutchComponents;
  if (!api || !api.versions) return;
  const seq = ++plugState.versionsSeq;
  plugState.versionsPending = name;
  renderPlugins();
  let out;
  Promise.resolve()
    .then(() => api.versions(name))
    .then((r) => {
      out = { name, rows: (r && Array.isArray(r.versions) ? r.versions : []), error: (r && r.error) || null };
    })
    .catch((e) => {
      out = { name, rows: [], error: (e && e.message) || String(e) };
    })
    .then(() => {
      if (seq !== plugState.versionsSeq) return; // superseded, or the block was closed
      plugState.versionsPending = null;
      plugState.versions = out;
      renderPlugins();
    });
}

function plugVersionsToggle(held) {
  if (plugState.versionsPending === held.name) return; // that read is already running
  if (plugState.versions && plugState.versions.name === held.name) {
    plugState.versions = null;
    plugState.versionsSeq++; // a late answer must not reopen what was closed
    renderPlugins();
    return;
  }
  plugReadVersions(held.name);
}

// An open version list is about what a machine HOLDS, so after any write that
// changed that, it is read again rather than trusted as it was.
function plugRefreshVersions() {
  const name = (plugState.versions && plugState.versions.name) || plugState.versionsPending;
  if (name) plugReadVersions(name);
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
  if (res && res.ok) {
    plugRead();
    plugRefreshVersions();
  }
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
  if (res && res.ok) {
    plugRead();
    plugRefreshVersions();
  }
}

// The one thing a row cannot carry: a write about a component that is not on
// screen. That happens for two honest reasons — a filter is hiding the row, or
// the row went away because the write took it away (the removal emptied it, and
// the read after it drew the machine as it now is). Either way the page must not
// go silent about a write it started: the stage, or the host's verdict, falls
// back here. While the row IS drawn, the note says nothing about the write.
function plugOrphanLine() {
  const shown = new Set(plugModel().filter(plugItemShown).map((i) => i.name));
  if (plugState.busy && !shown.has(plugState.busy.name)) {
    return { text: plugStageLine(plugState.busy), bad: false };
  }
  if (plugState.result && !shown.has(plugState.result.name)) {
    return { text: plugState.result.text, bad: !plugState.result.ok };
  }
  return null;
}

function renderPlugins() {
  plugBodyEl.innerHTML = ""; // full redraw: one list, one state object
  plugTargetEl.textContent = plugTargetName(plugState.target);
  plugBaseEl.textContent = plugState.target && plugState.target.base ? plugState.target.base : "";
  // the note is the PAGE's line now, not the log of a write: what a write is doing
  // and what the host answered are drawn on the row they are about (plugItemState),
  // so what is left here is what no row can say — this page's own reads. A read
  // that failed outranks everything (it is why the list is short), then a write
  // whose row is not on screen, then a read still running.
  const problem = plugState.heldError || plugState.marketError;
  const orphan = problem ? null : plugOrphanLine();
  let note = "";
  let bad = false;
  if (problem) {
    note = problem;
    bad = true;
  } else if (orphan) {
    note = orphan.text;
    bad = orphan.bad;
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
  plugDrawFilter();
  plugBodyEl.appendChild(plugList());
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
