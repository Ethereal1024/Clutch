// the plugin tab: what the two places hold, and what this client can still give
// them
//
// There is no machine picker here, and no machine named, because there is nothing
// to pick: WHERE a component goes is a fact of its declaration (`destinationOf`
// in ui/components.js) — a plugin is THIS client (the app process holds it and
// runs it), a cli/daemon is the machine the session runs its commands on — and
// that answer is the same in every session. A page that offered the choice would
// be asking the user to learn a rule it already knows, and a page that printed
// the answer would spend a line on a fact nobody can act on.
//
// What is left to say is what the page can observe (ui/components-view.js answers
// all of it over the clutchComponents channel):
//   * what each place HOLDS, from its own inventory: the session machine over its
//     supervisor, this client from its plugin domain. Each half can fail on its
//     own and says so in its own words.
//   * the MARKET this client knows: the checkouts beside the host repo plus every
//     release the one market index names.
//
// A read that failed is DATA here, never a blank page: a place that did not
// answer is drawn as the reason it did not. "Nothing is installed" and "the
// machine could not be asked" look exactly alike in an empty list, and that is
// the one reading this page must not give.
//
// Three writes this page can perform, offered according to what each one costs
// (PLUGIN_PLAN.md I5). A sentence that has to say WHERE says which of the two
// places it means ("this client", "this session") and never offers a third; the
// confirmations say what the act actually costs (an install writes bytes over
// whatever version is there; a removal DELETES them — neither is a rollback,
// because nothing here keeps a copy of what it replaces or takes away), and the
// outcome is always the host own verdict, quoted. The switch is the one write
// that touches no bytes and is reversible from the very control that asks for it,
// so it asks nothing: teaching the user to click through a confirmation on a
// free, undoable act is how they learn to click through the two that are neither.
// A place this build cannot reach never becomes an offer to write: the control is
// dead and its title is the sentence, instead of a button that pretends the write
// will land.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely on
// anything above it in ui/index.html and on nothing below it.

"use strict";

const plugBodyEl = $("#plug-body");
const plugFilterEl = $("#plug-filter");
const plugNoteEl = $("#plug-note");
const plugReloadBtn = $("#plug-reload");
const plugMirrorInput = $("#mirror-input");
const plugMirrorSaveBtn = $("#mirror-save");
const plugMirrorNoteEl = $("#mirror-note");

const plugState = {
  // the list has answered once — a place that was never read is not a place that
  // holds nothing, and this is the bit that tells the two apart
  read: false,
  sessionBase: "", // the session machine supervisor URL, as the view resolved it
  sessionError: null, // why the session machine cannot be AIMED at at all
  sessionHeldError: null, // why its own list did not arrive (the place itself is reachable)
  client: false, // this shell holds a client plugin domain
  clientError: null, // why that domain cannot be aimed at (or why it would not open)
  clientHeldError: null, // why its own list did not arrive
  held: [], // the rows BOTH places hold, each tagged with its own `place`
  market: null, // {entries, errors, unreachable, origin, note}
  marketError: null, // why the market read itself failed
  pending: 0, // in-flight reads: the note line is derived from them
  mirrors: null, // [{url, source}] — the list a failed fetch is retried through, or null while unread
  mirrorsError: null, // why that list could not be read
  mirrorForced: "", // the prefix every source is forced through, when one is set
  mirrorDraft: "", // the mirror being typed into the field (never persisted)
  mirrorBusy: false, // an add/remove in flight: the field and the buttons are dead behind it
  mirrorResult: null, // {ok, text} — what the list said about the last add or remove
  busy: null, // {name, verb, stage} — a write in flight, nothing else may start
  result: null, // {ok, text} — the host's verdict on the last write
  versions: null, // {name, rows, error} — the one open version list, as just read
  versionsPending: null, // name whose version list is being read right now
  versionsSeq: 0, // which version-list read is the current one (closing bumps it)
  filter: "all", // which slice of the ONE list is on screen (never persisted)
  query: "", // the name filter, as typed (never persisted)
};

// Where ONE row bytes live, in the two words the declaration speaks. This is not
// a field and not a choice: `destinationOf` (ui/components.js) derives it from the
// declaration, so it is the same in every session and there is no third value to
// offer. The page says it only inside a sentence that would otherwise be about
// nothing ("removed from where?"), never as a heading a user has to read.
function plugPlace(item) {
  const place = item && item.place;
  if (place === "client") return "this client";
  if (place === "session") return "this session";
  return "";
}

// The same place said in a sentence, where the sentence has to read even when the
// page does not know it yet: a market row is drawn from the index alone (opening
// the page is one read in ui/components.js `marketEntries`), and its release's
// declaration — the only thing that says whose machine it is — arrives when
// something is installed from it. Naming that is honest; inventing a machine is
// not.
function plugPlaceName(item) {
  const place = typeof item === "string" ? item : item && item.place;
  if (place === "client") return "this client";
  if (place === "session") return "this session";
  return "the machine its declaration names";
}

// A row whose declaration has not been read YET, which is the ordinary state of
// everything the market offers and no domain holds. It is not a refusal: the
// install reads the declaration and derives the place before a byte is built
// (ui/components-view.js `specFor`), so the button stays live and the refusal, if
// there is one, is the declaration's own sentence.
function plugPlaceUnread(item) {
  return Boolean(item) && item.read === false && !item.problem;
}

// Whether the place a row names can be reached BY THIS BUILD right now, as a
// sentence, or null when it can. This is the whole of what used to be a machine
// selector: a plugin is held by the app process itself (always here, or this
// shell has no plugin domain at all), and a cli/daemon is held by the machine the
// session runs its commands on — out of reach exactly when that domain did not
// answer, because a degraded session runs its tools over an exec bridge, and an
// exec bridge is not a component channel.
function plugPlaceReady(place) {
  if (place === "client") {
    return plugState.client
      ? null
      : plugState.clientError || "this shell has no client plugin domain, so a plugin has nowhere to go here";
  }
  if (place === "session") {
    if (!plugState.read) {
      return "the components have not been read yet — nothing is sent to a place this page has not found";
    }
    return plugState.sessionError || null;
  }
  return "this component declares no place, so there is no machine that could receive it";
}

// Whether a place that CAN be written to simply did not tell us what it holds.
// This is not a refusal: a supervisor that answers writes but not an inventory is
// a place with an unseen shelf, and the page says which of the two it is instead
// of killing a write it could make (the host still decides what a name means).
function plugHeldError(place) {
  if (place === "client") return plugState.clientHeldError || null;
  if (place === "session") return plugState.sessionHeldError || null;
  return null;
}

// The one sentence a row needs when its place is unknown: either the place cannot
// be reached at all, or it answered without its list. Both leave the row unsaid
// and neither is "not installed".
function plugPlaceUnknown(place) {
  return plugPlaceReady(place) || plugHeldError(place);
}

function plugChip(text, cls) {
  const el = document.createElement("span");
  el.className = "plug-chip" + (cls ? " " + cls : "");
  el.textContent = text;
  return el;
}

// ONE row's facts, as a node assistive tech can read and the eye cannot: the same
// sentence the row's `title=` carries. A `title` needs a pointer resting on the
// row and is exposed to nobody on a keyboard or a touch screen, and the facts a row
// no longer PRINTS (U-10) would then be readable by mouse alone. The id is what
// `aria-describedby` points at, so every row that has facts gets its own.
let plugIdSeq = 0; // one id per node an aria attribute has to be able to point at
function plugFactsNode(text) {
  const el = document.createElement("span");
  el.className = "sr-only";
  el.id = "plug-row-facts-" + ++plugIdSeq;
  el.textContent = text;
  return el;
}

// Every control under one action carries the row's facts — the menu's items are
// built before their menu is, so they hang off it and are reached from here. Each
// of them acts on this one component, and the description says which.
function plugDescribeTree(el, id) {
  if (!el || typeof el.setAttribute !== "function") return;
  el.setAttribute("aria-describedby", id);
  for (const child of el.children || []) plugDescribeTree(child, id);
}

// ONE row, in the shape VS Code gives one extension (extensionsList.ts:70-159,
// renderTemplate): the WORDS down the left — a header line (the name, and whatever
// small state marks belong beside it), then ONE line of description — and the
// row's controls on the right of them. VS Code's row is the same two columns
// (`media/extension.css`: the item is `display: flex`, `.details` the column that
// takes `flex: 1`), and its ActionBar takes the right end too — but of the row's
// LAST line, because it is built inside `.details > .footer`
// (`extensionsList.ts:89-91`) and pushed there by the publisher that shares that
// line with it. We draw no publisher line, so here the controls are the column
// itself, centred on the words. Then, under both, the thing that belongs UNDER the
// row (a version list), or nothing.
//
// The two columns are `.plug-row-main` and `.plug-row-actions` (ui/style.css says
// the rest): stacked, a row of four controls is as wide as the pane and its one
// sentence is cut to whatever the name above it does not need — the left half of
// the controls' line and the right half of the sentence's are both empty, which is
// the shape a phone forces and a pointer never has to accept. On a phone they
// stack again (ui/mobile.css): there, four finger-sized targets ARE the width of
// the pane, and squeezing the name beside them is the fight the name loses.
//
// What is deliberately NOT here is the pile of facts a row used to carry: the
// digest, the source path, the "release under it", the offered-versus-held
// version. That is metadata about the component, not the row's business, and VS
// Code puts exactly that material one click away (the extension editor) instead of
// in the list (extensionsList.ts:167-170 gives the description line `.ellipsis`,
// i.e. one line, cut short; the version/rating counts beside the name are the only
// numbers the row shows). Here it goes on the row's own `title=`, which is the one
// place a summary can be complete without being drawn — and into the Versions
// disclosure, which is the holding place's own answer, not ours.
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
// itself (`state.row`), which is how "this place holds it but is not driving
// it" is said without a second block of text (VS Code: `.disabled` on the row,
// extensionsList.ts:185-191).
function plugRow(name, { chips = [], desc = "", lines = [], actions = [], extra = null, state = null, title = "", role = "" } = {}) {
  const row = document.createElement("div");
  row.className = "plug-row" + (state && state.row ? " " + state.row : "");
  // a component row is an ITEM of the list (`plugSection` wraps them in the list
  // itself); a version row is not, so its caller passes nothing and it stays a
  // plain box — a `listitem` outside a list is a lie about the shape of the page
  if (role) row.setAttribute("role", role);
  if (title) row.title = title;
  // a write in flight is a STATE of the row, and the stage line under the name is
  // its sentence: `aria-busy` is how assistive tech hears "this one is moving"
  if (state && state.cls === "busy") row.setAttribute("aria-busy", "true");
  // the words' column: the head, the state line and the sentence are one block, so
  // the column as a whole is what yields width to the controls
  const main = document.createElement("div");
  main.className = "plug-row-main";
  const head = document.createElement("div");
  head.className = "plug-row-head";
  const nameEl = document.createElement("span");
  nameEl.className = "plug-name";
  nameEl.textContent = name;
  head.appendChild(nameEl);
  for (const [text, cls] of chips) head.appendChild(plugChip(text, cls));
  main.appendChild(head);
  if (state && state.text) {
    const el = document.createElement("div");
    el.className = "plug-line plug-state" + (state.cls ? " " + state.cls : "");
    el.textContent = state.text;
    main.appendChild(el);
  }
  if (desc) {
    const el = document.createElement("div");
    el.className = "plug-row-desc";
    el.textContent = desc;
    main.appendChild(el);
  }
  for (const line of lines) {
    if (!line) continue;
    const el = document.createElement("div");
    el.className = "plug-line";
    el.textContent = line;
    main.appendChild(el);
  }
  row.appendChild(main);
  // the controls get the row's OTHER column, on the right of the words — VS Code's
  // ActionBar is the union of the actions an item offers and it takes the right end
  // of a row as well, only of the row's LAST line (it shares that line with the
  // publisher: `extensionsList.ts:89-91`, `media/extension.css`). Under the words
  // they would cost a whole line per row, and the sentence beside them would be cut
  // to the width of the name above it; beside THEM the words keep the room and give
  // up their tail first (the name truncates, ui/style.css). On a phone they stack
  // again (ui/mobile.css).
  if (actions.length) {
    const foot = document.createElement("div");
    foot.className = "plug-row-actions";
    for (const a of actions) foot.appendChild(a);
    // `title=` is drawn on hover and on nothing else: on a keyboard or a touch
    // screen a `title` is unreachable, so the facts a row no longer PRINTS (U-10)
    // would be readable by pointer alone. The same sentence goes into an sr-only
    // node on the row's own control line, and every control in that line — the
    // menu's items included — points at it with `aria-describedby`: whichever one
    // the user lands on, the facts arrive with it. Nothing gains a tab stop, and
    // nothing gains a drawn word.
    const facts = title ? plugFactsNode(title) : null;
    if (facts) {
      for (const a of actions) plugDescribeTree(a, facts.id);
      foot.appendChild(facts);
    }
    row.appendChild(foot);
  }
  if (extra) row.appendChild(extra);
  return row;
}

function plugSection(title, meta, rows, empty) {
  const sec = document.createElement("div");
  sec.className = "plug-section";
  const head = document.createElement("h4");
  // the heading is the MACHINE's name — DATA, never a field label — so it is the
  // one heading in this modal that must not be set in caps (.modal-box h4 does
  // that to every h4 it meets, and the same screen then read `SSH ubuntu@box` up
  // here and `SSH UBUNTU@BOX` in the row beside it)
  head.className = "plug-section-title";
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
    // the rows ARE a list, and saying so gives them a count and an item boundary
    // ("list, 12 items") instead of twelve anonymous boxes. The list is the rows
    // only: the caution and the source errors below are the SECTION's, not items
    // of it.
    const list = document.createElement("div");
    list.className = "plug-items";
    list.setAttribute("role", "list");
    for (const r of rows) list.appendChild(r);
    sec.appendChild(list);
  } else {
    const el = document.createElement("p");
    el.className = "plug-empty";
    el.textContent = empty;
    sec.appendChild(el);
  }
  return sec;
}

// The whole list model, and the reason there is only one list: both
// inventories (the session machine's and this client's) and the market this
// client knows are joined BY NAME, so a component held in EITHER place and
// offered is ONE row. The user never lines up two sections to learn whether
// something is installed, and a row held in one place and offered for the other
// says both, which is exactly how the declaration is meant to read.
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
  // either place holds that the market does not list
  for (const e of plugState.market ? plugState.market.entries : []) slot(e.name).entry = e;
  for (const h of plugState.held || []) {
    const cell = slot(h.name);
    // ONE name has ONE place (the declaration says which), so when both domains
    // hold the same name the row is the one the declaration names and the other is
    // a leftover this page will not install over
    if (!cell.held || (cell.entry && h.place === cell.entry.place)) cell.held = h;
  }
  return order.map((n) => byName.get(n));
}

// The five views of the ONE list. A view is a way of LOOKING at what the two
// places hold and what this client knows, not a fact about either: nothing here is
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
  if (plugHeldLegacy(item.held)) return true;
  const offered = String(item.entry.version || "");
  return Boolean(offered) && String(item.held.version || "").split("+")[0] !== offered;
}

// A record from before every install carried a version: the inventory then says
// `5f900739e6a35f43` — the identity of the bytes and nothing else, so the release
// was never recorded at all. The gate already refuses to call such a record
// current (it compares version AND digest, agent/tools/components.py `current()`,
// ui/components-view.js), so any pass or click replaces it; what this predicate is
// for is SAYING that, because a bare digest under "held" reads like a version that
// merely looks odd. Old records are reinstalled rather than kept beside the new
// shape (PLUGIN_PLAN.md 七.2).
function plugHeldLegacy(held) {
  const version = String((held && held.version) || "");
  return Boolean(version) && !version.includes("+");
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
  // the chips are the five views of ONE list, so they are announced as a group —
  // and each chip is a toggle, whose state is otherwise carried by `.active` alone
  // (a class nobody using assistive tech can hear)
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "which components to show");
  plugFilterChips = [];
  for (const [id, label] of PLUG_FILTERS) {
    const btn = document.createElement("button");
    btn.className = "plug-filter-chip";
    btn.type = "button";
    btn.textContent = label;
    btn.setAttribute("aria-pressed", String(id === plugState.filter));
    btn.title = `show only ${label.toLowerCase()} of what the two places hold and this client knows`;
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
  // a placeholder is not a name: this box sits in a row of chips with no label of
  // its own, so it says what it is out loud
  input.setAttribute("aria-label", "filter the list by name");
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
    const on = id === plugState.filter;
    btn.classList.toggle("active", on);
    // the filled mark is the view that is ON; `aria-pressed` says the same thing to
    // a screen reader, which cannot see a background colour
    btn.setAttribute("aria-pressed", String(on));
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

// The row's ONE line: what this component's relationship to the place it names is,
// in one sentence. VS Code's list gives the description line the same job — one
// line, cut short (`extensionsList.ts:167-170`, `.description.ellipsis`) — and it
// is the row's only prose because everything else a row could say (digest, source,
// path, the versions it holds) is either the holding place's own answer in the Versions
// disclosure or one of the facts below.
function plugItemDesc(item) {
  const held = item.held;
  const entry = item.entry;
  const where = plugPlace(held || entry);
  if (held && held.disabled) return `held on ${where}, but not driven: its tools are not offered here`;
  if (held && entry) {
    return plugItemUpdate(item)
      ? `installed — this client offers ${entry.version || "another version"}`
      : "installed — nothing newer is offered here";
  }
  if (held) return "installed — the market does not list it";
  // a declaration that names no place (or names a pair that cannot exist) is
  // refused before any byte is built, and its own sentence is the row's line
  if (entry && entry.problem) return entry.problem;
  if (entry && !plugPlaceUnread(entry) && plugPlaceUnknown(entry.place)) {
    // the place was not read, cannot be reached, or answered without its list:
    // "unknown" is a fact, not an empty list — and it is the one thing that
    // explains a dead Install beside us
    return `on ${where}, unknown`;
  }
  return "not installed";
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
    // what the record IS, when it predates versions: the number above is a digest,
    // and the reinstall beside this row is what turns it into a release
    if (plugHeldLegacy(held) && entry && entry.version) {
      const digest = String(held.digest || "").slice(0, 16) || String(held.version);
      meta.push(`an old record: a reinstall names it ${entry.version}+${digest}`);
    }
  }
  if (entry) {
    // the one placement fact a row has: which of the two places its declaration
    // names. It is not a choice and not a field — it is what the row IS
    const place = plugPlace(entry);
    if (place) meta.push("goes to " + place);
    else if (plugPlaceUnread(entry)) meta.push("its place is its declaration's, read when something is installed from it");
    if (entry.problem) meta.push("refused: " + entry.problem);
    if (!held) {
      // a place that could not be read, or one this build cannot reach, is why the
      // Install beside this row is dead — the tooltip says it in full
      const refuse = plugPlaceUnread(entry) ? "" : plugPlaceUnknown(entry.place);
      if (refuse) meta.push(refuse);
    }
    // a row is offered by the market, or by a checkout beside the host repo (a
    // contributor's edit) — the page says which, because the bytes differ
    const from = entry.origin === "checkout" ? "from this checkout" : "from the market";
    meta.push(`offered ${entry.version || "at an unnamed version"} (${from})`);
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
// button: a component this client can offer leads with the write that puts it in
// the place its declaration names, and a row already held there -> the switch.
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
    actions.push(plugMoreButton(item, menu), menu);
  }
  return actions;
}

// What the row can do BESIDE that write, in the order it is offered: the switch
// (unless the switch IS what the row leads with), then the write this client can
// still make (the same release again — the "Reinstall" an installed component
// keeps in its menu, the way VS Code keeps "Install Another Version…" in the
// Manage menu, extensionsActions.ts:1338-1405), then the versions the place
// holds, then the removal, which is the one write that DELETES and is exactly why
// it is never the button a row leads with (PLUGIN_PLAN.md I5). The comparison is
// by KIND and not by node: the items are built here, so identity would say
// "different" about two buttons that are the same control.
function plugItemMenuItems(item, lead) {
  const items = [];
  if (!item.held) return items; // a component neither place holds has nothing else to offer
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
  // the "…" names this box in `aria-controls`, so it needs an id of its own
  box.id = "plug-menu-" + ++plugIdSeq;
  for (const item of items) box.appendChild(item);
  return box;
}

// The "…" itself: never a write, so it is live whenever the row is, and its title
// says the two things its label cannot — which component, and which of the two
// places the row is about. The label is a GLYPH, which reads as "…" and nothing
// else, so the button carries the name it means; and because what it opens is
// drawn once and shown by a class, its expanded state is said out loud rather than
// only drawn.
function plugMoreButton(item, menu) {
  const name = item.name;
  const where = plugPlaceName(item.held || item.entry);
  const btn = document.createElement("button");
  btn.className = "plug-more";
  btn.type = "button";
  btn.textContent = "…";
  btn.title = `everything else ${name} can do on ${where}`;
  btn.setAttribute("aria-label", `more actions for ${name} on ${where}`);
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-controls", menu.id);
  btn.setAttribute("aria-expanded", String(menu.classList.contains("open")));
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
    btn.setAttribute("aria-expanded", String(open));
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
    // the class IS the state, so the state that is SAID out loud is cleared with
    // it: a menu some other click closed must not still answer `aria-expanded`
    const opener = el.previousElementSibling;
    if (opener && opener.setAttribute) opener.setAttribute("aria-expanded", "false");
  }
}
document.addEventListener("click", () => plugCloseMenus());
// Escape is the keyboard's "click anywhere else" — and it has to be the DOCUMENT's,
// because the menu hangs off the control beside its opener, not inside the control:
// Escape pressed while the focus is on the "…" and Escape pressed three items into
// the menu it opened have to do the same thing.
document.addEventListener("keydown", (ev) => {
  if (ev && ev.key === "Escape") plugCloseMenus();
});

function plugItemRow(item) {
  return plugRow(item.name, {
    // an item of the one list (plugSection puts the rows in the list itself)
    role: "listitem",
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

// What "nothing to draw" means here. A place that could not be read is NOT a place
// holding nothing: an empty list and an unanswered read must not look
// alike (a failed read is data on this page). And a filter that hides every row
// is a third thing again — the places do hold components, this view is simply
// not showing them.
function plugEmptyText(known, shown) {
  if (!plugState.read && plugState.market === null) {
    const why = plugReadProblem();
    return why ? "could not be read — " + why : "reading…";
  }
  if (known && !shown) return "no component here matches this filter";
  return "nothing is installed in either place, and the market lists nothing for this build";
}

// The page own read failures, in the order they explain an empty or short list:
// the session machine (the place a cli/daemon lives, and the one out of reach in a
// degraded session), then this client plugin domain, then the market. A row that
// needs the missing half says the same sentence in its own title; this is the one
// line under the list, so a page WITH rows in it still says what it could not see.
function plugReadProblem() {
  return (
    plugState.sessionError ||
    plugState.sessionHeldError ||
    plugState.clientError ||
    plugState.clientHeldError ||
    plugState.marketError ||
    null
  );
}

// The one list. It is not titled with a machine, because there is no single
// machine this window acts on: some of what it holds belongs to this client and
// some to the session machine, and WHICH is which is a fact of each row
// declaration, not of the page. The counts say how much of the list is held
// somewhere, and how much of it the market offers.
function plugList() {
  const items = plugModel();
  const shown = items.filter(plugItemShown);
  const meta = [];
  if (plugState.read) meta.push(`${plugState.held.length} installed`);
  else meta.push("reading");
  if (plugState.market) meta.push(`${plugState.market.entries.length} known`);
  else if (plugState.marketError) meta.push("market unreadable");
  // WHICH index answered: the remote one is the ordinary case and needs no
  // words; a cached or shipped copy is not the current market, and a page that
  // showed it as if it were would be saying something it does not know
  const origin = plugState.market && plugState.market.origin;
  if (origin && origin !== "remote") meta.push(`index ${origin}`);
  // a filtered list says so: the count behind the title is about both places,
  // this one about what is on screen
  if (shown.length !== items.length) meta.push(`${shown.length} shown`);
  const sec = plugSection(
    "Components",
    meta.join(" · "),
    shown.map(plugItemRow),
    plugEmptyText(items.length, shown.length)
  );
  if (plugState.market && plugState.market.entries.length) {
    const caution = document.createElement("p");
    caution.className = "plug-caution";
    caution.textContent = "install writes bytes where the declaration puts them, and Remove deletes them — neither is a rollback, since nothing here keeps a copy of what it replaces or takes away (the switch is the third write: it deletes nothing, and pressing it again is the undo)";
    sec.appendChild(caution);
  }
  // a row that did not survive the index (a bad line, a manifest that failed its
  // pin) explains a short list: one line each, together at the end rather than
  // scattered through the rows it shortened
  for (const reason of (plugState.market && plugState.market.errors) || []) {
    const el = document.createElement("p");
    el.className = "plug-source-error";
    el.textContent = reason;
    sec.appendChild(el);
  }
  // ...and when the list is not the current market, the view says why in one
  // sentence (the remote index did not answer just now, so this is the copy this
  // machine cached, or the one this build ships). A list should say which list it
  // is — that sentence is the difference between "nothing new" and "I could not
  // ask".
  if (plugState.market && plugState.market.note) {
    const el = document.createElement("p");
    el.className = "plug-source-hint";
    el.textContent = plugState.market.note;
    sec.appendChild(el);
  }
  // ...and when the failure is the network rather than an answer (the view says
  // which: `unreachable`), one more line says what can be done about it. Two
  // answers, and the page has to name both: a fetch that fails for a
  // network-looking reason is retried through the mirror list (the Mirrors
  // section below — this build's own entries plus the user's), while the
  // `source_mirror` FIELD drawn above this list moves every read there was,
  // manifest included. This line is the pointer to both, and the file it names
  // is where the same key lands on a desktop.
  if (plugState.market && plugState.market.unreachable) {
    const hint = document.createElement("p");
    hint.className = "plug-source-hint";
    hint.textContent =
      "the market index and every release manifest are read from github.com. A fetch that " +
      "fails for a network reason is retried through the mirrors listed under Mirrors below, " +
      "and the source mirror box above (it writes \"source_mirror\" into " +
      "~/.clutch/settings.json) moves every read there was. Either way a mirror only moves " +
      "the bytes: every digest is still checked against the release's own pin";
    sec.appendChild(hint);
  }
  return sec;
}

// ---- the mirrors -----------------------------------------------------------
//
// Where a fetch the release host cannot answer is retried (ui/mirrors.js). The
// retry happens on the PLACE the install is aimed at — its own fetch of the
// bytes is the one that failed (ui/components.js fetchInstall) — so this section
// owns one thing only: the LIST as this client reads it, which is why it is one
// more read beside the inventory and the market and not a setting of its own.
//
// A shipped entry carries no Remove: it is what the fallback is made of, and a
// build whose list could be emptied from here would lose the feature without
// saying so (ui/mirrors.js `remove` refuses it in those words). The user's own
// entries are the ones this page writes, and the order they are tried in is the
// plain one — the user's first, then the build's.
function plugMirrorRow(entry) {
  const own = entry.source === "user";
  const row = plugRow(entry.url, {
    chips: [[own ? "yours" : "shipped"]],
    desc: own ? "tried before the entries this build ships" : "shipped by this build: always tried, never removable",
    actions: own ? [plugMirrorRemoveButton(entry.url)] : [],
    role: "listitem",
  });
  // a row that names a MIRROR and not a component: the same box for a different
  // kind of thing, and the page's own readers of `.plug-name` skip it by this
  row.classList.add("plug-mirrors");
  return row;
}

function plugMirrorRemoveButton(url) {
  const forced = plugState.mirrorForced;
  const btn = document.createElement("button");
  btn.className = "plug-mirrors-remove";
  btn.type = "button";
  btn.textContent = "Remove";
  btn.disabled = Boolean(forced || plugState.mirrorBusy);
  btn.title = forced
    ? `every source is already read through ${forced} (CLUTCH_SOURCE_MIRROR, or "source_mirror" in ~/.clutch/settings.json), so this list is not used — clear that setting to fall back through it`
    : `stop trying ${url} when a release host cannot be reached`;
  btn.addEventListener("click", () => plugMirrorRemove(url));
  return btn;
}

// The one field on this page that writes a LIST rather than bytes: an http(s)
// prefix, added to the user's half of it. The refusal (a value already in either
// list, a value that is not a prefix) is drawn under the field, in the list's own
// words — a write this page cannot confirm any other way.
function plugMirrorForm() {
  const wrap = document.createElement("div");
  wrap.className = "plug-mirrors-add";
  const forced = plugState.mirrorForced;
  const input = document.createElement("input");
  input.className = "plug-mirrors-input";
  input.type = "text";
  input.value = plugState.mirrorDraft || "";
  input.placeholder = "https://gh-proxy.com";
  input.title = "a mirror is a URL prefix: <prefix>/<the release's absolute URL>";
  input.disabled = Boolean(forced || plugState.mirrorBusy);
  input.setAttribute("aria-label", "a mirror to add, as an https URL");
  // no redraw per keystroke: the caret stays where the user is typing, and the
  // field's value is state (a redraw puts it back)
  input.addEventListener("input", () => {
    plugState.mirrorDraft = input.value || "";
  });
  const btn = document.createElement("button");
  btn.className = "plug-mirrors-add-btn";
  btn.type = "button";
  btn.textContent = plugState.mirrorBusy ? "Adding…" : "Add";
  btn.disabled = Boolean(forced || plugState.mirrorBusy || !String(plugState.mirrorDraft || "").trim());
  btn.title = forced
    ? `the list is not used while every source is read through ${forced}`
    : "try this mirror when a release host cannot be reached";
  btn.addEventListener("click", () => plugMirrorAdd());
  wrap.appendChild(input);
  wrap.appendChild(btn);
  return wrap;
}

// The mirror list, as one more section of the same page — directly under the
// components, because that is what it silently serves.
function plugMirrors() {
  const list = plugState.mirrors || [];
  const mine = list.filter((m) => m.source === "user").length;
  const meta = plugState.mirrorsError
    ? "unreadable"
    : plugState.mirrors
      ? `${mine} of yours · ${list.length - mine} shipped`
      : "reading…";
  const empty = plugState.mirrorsError
    ? "the list of mirrors could not be read"
    : plugState.mirrors
      ? "no mirror is tried: this build ships none and none was added"
      : "reading the list…";
  const sec = plugSection("Mirrors", meta, list.map(plugMirrorRow), empty);
  // what a mirror IS here, and what it cannot do: the place a component goes to
  // fetches the same pinned bytes through each one, and the digest is still the
  // release own pin — a mirror can move the bytes, it can never vouch for them
  const note = document.createElement("p");
  note.className = "plug-mirrors-note";
  note.textContent =
    "tried in this order when a release host cannot be reached — the place a component goes to fetches the same pinned " +
    "bytes through each one and weighs them against the release's own digest, so a mirror can move the bytes " +
    "but never vouch for them";
  sec.appendChild(note);
  if (plugState.mirrorsError) {
    const err = document.createElement("p");
    err.className = "plug-source-error";
    err.textContent = plugState.mirrorsError;
    sec.appendChild(err);
  } else {
    sec.appendChild(plugMirrorForm());
  }
  if (plugState.mirrorForced) {
    // the knob that outranks the list: with a prefix set, every source AND every
    // release URL was already rewritten before anything was read, so there is no
    // per-source fallback left to take
    const forced = document.createElement("p");
    forced.className = "plug-mirrors-forced";
    forced.textContent =
      `every source is read through ${plugState.mirrorForced} before anything else ` +
      '(CLUTCH_SOURCE_MIRROR, or "source_mirror" in ~/.clutch/settings.json), so this list is not used while that is set';
    sec.appendChild(forced);
  }
  const res = plugState.mirrorResult;
  if (res) {
    const line = document.createElement("p");
    line.className = "plug-mirrors-result" + (res.ok ? "" : " error");
    line.textContent = res.text;
    sec.appendChild(line);
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

// What the control that is dead behind that write says it is doing, in one word.
// The "…" it used to carry said "something is happening" to the eye and, to anyone
// reading the page out loud, only an ellipsis: a button relabelled "…" is a button
// with no name. Same four verbs, same rule as above — an install carries the
// default verb, and the two directions of the switch are never spelled as each
// other — and `fallback` is what a write of that kind is called from that control.
function plugBusyLabel(busy, fallback) {
  if (busy.verb === "remove") return "Removing…";
  if (busy.verb === "disable") return "Stopping…";
  if (busy.verb === "enable") return "Starting…";
  return fallback;
}

// The switch: stop the machine DRIVING one component it holds, or start again.
// It lives on the held row because that is the row whose fact it changes, and it
// is offered with the least ceremony of the three writes — it deletes nothing and
// its own label is the undo, so there is no question to ask. What it must still
// say is what the user cannot see: which of the two places is being switched, and
// that the bytes are not what moves.
function plugSwitchButton(held) {
  const busy = plugState.busy && plugState.busy.name === held.name;
  const stopped = Boolean(held.disabled);
  const btn = document.createElement("button");
  btn.className = "plug-switch" + (stopped ? " stopped" : "");
  btn.type = "button";
  btn.textContent = busy ? plugBusyLabel(plugState.busy, stopped ? "Starting…" : "Stopping…") : stopped ? "Enable" : "Disable";
  const refuse = plugPlaceReady(held.place);
  const where = plugPlace(held);
  if (refuse) {
    // the place that holds it cannot be reached from here: the sentence, not a
    // button that pretends the write would land
    btn.disabled = true;
    btn.title = refuse;
  } else if (!window.clutchComponents || !window.clutchComponents.setDisabled) {
    // a shell without the verb must not draw a control that looks like one
    btn.disabled = true;
    btn.title = "this shell cannot switch components at all";
  } else if (plugState.busy) {
    btn.disabled = true;
    btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
  } else if (stopped) {
    btn.title = `drive ${held.name} on ${where} again — its bytes stay where they are`;
  } else {
    btn.title =
      `stop ${where} driving ${held.name} — it stays installed and listed, ` +
      "its tools are no longer offered, and nothing is deleted";
  }
  btn.addEventListener("click", () => plugSwitch(held));
  return btn;
}

// The reverse verb for one installed component: the row IS the thing that can
// go, so the control lives beside it and names it. Same discipline as the
// install control — it is dead while the place that holds it cannot be reached
// (which place would lose the bytes is exactly what must not be guessed) and while
// any write is in flight, and its title says what it would take off where.
function plugRemoveButton(held) {
  const busy = plugState.busy && plugState.busy.name === held.name;
  const btn = document.createElement("button");
  btn.className = "plug-remove";
  btn.type = "button";
  btn.textContent = busy ? plugBusyLabel(plugState.busy, "Removing…") : "Remove";
  const refuse = plugPlaceReady(held.place);
  if (refuse) {
    btn.disabled = true;
    btn.title = refuse;
  } else if (plugState.busy) {
    btn.disabled = true;
    btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
  } else {
    const version = held.version ? " " + held.version : "";
    btn.title = `remove ${held.name}${version} from ${plugPlace(held)}`;
  }
  btn.addEventListener("click", () => plugRemove(held));
  return btn;
}

// The disclosure for one held row: what every version of this component looks
// like IN THE PLACE that holds it. It is a READ, not a write — so it is never
// dead behind a write in flight (the reload is not either), and what it opens is
// the place's own answer, kept only as long as the block is open: this page
// keeps no second copy of a place's truth (frozen decision 3).
function plugVersionsButton(held) {
  const open = Boolean(plugState.versions && plugState.versions.name === held.name);
  const reading = plugState.versionsPending === held.name;
  const btn = document.createElement("button");
  btn.className = "plug-versions" + (open ? " open" : "");
  btn.type = "button";
  btn.textContent = reading ? "Reading…" : open ? "Hide versions" : "Versions";
  // a disclosure, drawn once and shown by a class: what it opens is the version
  // list under the row, and its own label flips with it — `aria-expanded` is the
  // same fact for a reader who cannot see the list appear
  btn.setAttribute("aria-expanded", String(open));
  const refuse = plugPlaceReady(held.place);
  if (refuse) {
    btn.disabled = true;
    btn.title = refuse;
  } else if (!window.clutchComponents || !window.clutchComponents.versions) {
    // a shell without the verb must not draw a control that looks like one
    btn.disabled = true;
    btn.title = "this shell cannot read a version list at all";
  } else if (reading) {
    btn.disabled = true;
    btn.title = `reading the versions of ${held.name} on ${plugPlace(held)}…`;
  } else if (open) {
    btn.title = `close the version list for ${held.name}`;
  } else {
    btn.title =
      `every version of ${held.name} that ${plugPlace(held)} holds, newest first — ` +
      "the marked one is what that place runs";
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
    line("reading the versions held there…");
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
    chips.push([record.resolved ? "this one is run" : "held beside it", record.resolved ? "accent" : ""]);
    const lines = [record.digest ? "digest " + String(record.digest).slice(0, 16) : ""];
    if (record.path) lines.push("at " + record.path);
    box.appendChild(
      plugRow(version, { chips, lines, actions: [plugRemoveOneButton(held, record)] })
    );
  }
  return box;
}

// The removal of ONE version. Same discipline as the whole-component one — dead
// while the place cannot be read or another write is flying, and asking first —
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
  btn.textContent = busy ? plugBusyLabel(plugState.busy, "Removing…") : "Remove";
  const refuse = plugPlaceReady(held.place);
  if (refuse) {
    btn.disabled = true;
    btn.title = refuse;
  } else if (plugState.busy) {
    btn.disabled = true;
    btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
  } else {
    btn.title = `remove ${held.name} ${version} from ${plugPlace(held)} — the versions beside it stay`;
  }
  btn.addEventListener("click", () => plugRemoveVersion(held, record));
  return btn;
}

// The install control for one market row. The label is derived from what the
// place that row goes to already holds, the way VS Code derives it from the gallery
// (`UpdateAction.computeAndUpdateEnablement()`, extensionsActions.ts:990-1010
// relabels Install to Update when the gallery has a newer version): an offered
// version neither place holds under that name installs, a different
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
  const where = plugPlaceName(entry);
  const btn = document.createElement("button");
  btn.className = "plug-install";
  btn.type = "button";
  btn.textContent = busy ? plugBusyLabel(plugState.busy, "Installing…") : same ? "Reinstall" : newer ? "Update" : "Install";
  // two refusals, and neither is a machine to pick: a declaration that names no
  // place (or names a pair that cannot exist) is refused by the view before any
  // byte is built, and a place this build cannot reach is a sentence rather than a
  // button that would fail after the click
  // a declaration the page has not read is not a refusal (plugPlaceUnread): the
  // install reads it first, and its sentence arrives in the result line instead
  const refuse = entry.problem || (plugPlaceUnread(entry) ? "" : plugPlaceReady(entry.place));
  if (refuse) {
    btn.disabled = true;
    btn.title = refuse;
  } else if (plugState.busy) {
    btn.disabled = true;
    btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
  } else if (same) {
    btn.title = `${where} already holds ${entry.name} ${held.version}`;
  } else if (newer && plugHeldLegacy(held)) {
    const digest = String(held.digest || "").slice(0, 16) || String(held.version);
    btn.title =
      `put ${entry.name} ${offered} on ${where} — it holds ${held.version}, a record from before ` +
      `installs carried a version: ${offered}+${digest} replaces it, and the old directory is ` +
      `deleted, not kept`;
  } else if (newer) {
    btn.title =
      `put ${entry.name} ${offered} on ${where} — ` +
      `it holds ${held.version} now, and the older one is replaced, not kept`;
  } else if (plugHeldError(entry.place)) {
    // the place is reachable and its shelf is unseen: the write is still the
    // place's to accept or refuse, and the title says which of the two this is
    btn.title = `what ${where} holds could not be read; the host still decides`;
  } else {
    btn.title = `install ${entry.name} on ${where}`;
  }
  btn.addEventListener("click", () => plugInstall(entry));
  return btn;
}

// Where an in-flight install is, in words the user can act on. The slow steps
// differ in kind, and the two domains differ in ALL of them: a session install
// either ships bytes over the tunnel or has the far machine fetch its own, while a
// client install never leaves this machine (its bytes are already here, or arrive
// as a release, and the app process lays them down). The stage names the place it
// belongs to, because that is the only sentence the two shapes do not share.
function plugStageLine(busy) {
  const where = plugPlaceName(busy);
  if (busy.verb === "remove") return `removing ${busy.name}${busy.version ? " " + busy.version : ""} from ${where}…`;
  // the switch is the one write with no bytes to build or send: it has one stage
  // and one place, and the sentence says which way it is going
  if (busy.verb === "disable") return `stopping ${busy.name} on ${where}…`;
  if (busy.verb === "enable") return `driving ${busy.name} on ${where} again…`;
  switch (busy.stage) {
    case "wake":
      // the machine's supervisor exits when it is idle, so the write that needs it
      // starts it again: this is the slow first start (the binary unpacks), not a
      // step of the install itself
      return `${where} is starting its supervisor…`;
    case "copy":
      // a plugin install has no tunnel and no supervisor in its path: the bytes are
      // brought onto this machine (a checkout is already here, a release is fetched
      // once into the digest-named cache) and the app process lays them down itself
      return `bringing ${busy.name} ${busy.version || ""} onto ${where}…`.replace("  ", " ");
    case "artifact":
      return `preparing the bytes for ${busy.name}…`;
    case "upload":
      return `sending ${busy.name} ${busy.version || ""} to ${where}…`.replace("  ", " ");
    case "fetch":
      // no bytes are in flight from here: the machine that will run the component
      // is getting them from the release, which is why this says so
      return `${where} is fetching ${busy.name} ${busy.version || ""}…`.replace("  ", " ");
    case "mirror":
      // the release's own URL did not answer and the machine is asking the SAME
      // pin of another place (ui/mirrors.js): one line, enough to tell a slow
      // install from a broken one, and it names the place being tried
      return `${where} could not reach the release host — trying ${busy.prefix || "a mirror"} instead…`;
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
  // which place the bytes came from, when it was not the release's own URL: the
  // install worked, and the user is the one who decided what may be tried
  const via = res.via ? ` · via ${res.via}` : "";
  return { ok: true, name: entry.name, text: `installed ${entry.name} ${res.version} on ${where}${via}${path}` };
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
// on this page, and the only thing that changed is whether this place offers
// its tools. "absent" is an ANSWER, not a failure: the request was already true
// in that place, so there was nothing there to stop or start — which usually
// means the switch was aimed at a place that does not hold the component at
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
  if (!api || !api.remove || plugState.busy || plugPlaceReady(held.place)) return;
  const where = plugPlace(held);
  const version = held.version ? " " + held.version : "";
  const go = await askConfirm({
    title: `Remove ${held.name}?`,
    text:
      `${held.name}${version} is deleted from the component directory on ${where}, together with any other version of it held there.` +
      " This cannot be undone from here: nothing in this app keeps a copy of what it removes," +
      " so putting it back means installing it again from a source.",
    ok: "Remove",
  });
  if (!go) return;
  plugState.busy = { name: held.name, verb: "remove", stage: "removing", place: held.place };
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
  // an inventory just changed: read both halves back (the counts and
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
  if (!api || !api.remove || plugState.busy || plugPlaceReady(held.place)) return;
  const where = plugPlace(held);
  const version = String(record.version || "");
  const go = await askConfirm({
    title: `Remove ${held.name} ${version}?`,
    text:
      `${held.name} ${version} is deleted from the component directory on ${where} — exactly the version named;` +
      " the versions beside it stay." +
      " This cannot be undone from here: nothing in this app keeps a copy of what it removes," +
      " so putting it back means installing it again from a source.",
    ok: "Remove",
  });
  if (!go) return;
  plugState.busy = { name: held.name, verb: "remove", stage: "removing", version, place: held.place };
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
  if (!api || !api.setDisabled || plugState.busy || plugPlaceReady(held.place)) return;
  const where = plugPlace(held);
  const disabled = !held.disabled; // the state being asked for, not the one it is in
  plugState.busy = { name: held.name, verb: disabled ? "disable" : "enable", stage: "starting", place: held.place };
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
  // what this place holds just changed: read the inventory back, so the row
  // that was stopped is drawn as stopped rather than as it was a moment ago
  if (res && res.ok) {
    plugRead();
    plugRefreshVersions();
  }
}

// The two mirror writes. Neither installs anything anywhere, so neither asks:
// a confirmation in front of a field the user just typed into is a second place
// to say the same thing, and an entry added by mistake is undone by the Remove
// on the row it creates. Both answer with the list AS IT NOW IS — the page then
// draws what was written, not what it hoped it asked for.
async function plugMirrorAdd() {
  const api = window.clutchComponents;
  const raw = String(plugState.mirrorDraft || "").trim();
  if (!api || !api.addMirror || plugState.mirrorBusy || !raw) return;
  plugState.mirrorBusy = true;
  plugState.mirrorResult = null;
  renderPlugins();
  let res;
  try {
    res = await api.addMirror(raw);
  } catch (e) {
    // the channel itself failed: still an answer this page has to draw
    res = { ok: false, error: (e && e.message) || String(e) };
  }
  plugState.mirrorBusy = false;
  if (res && res.ok) {
    plugState.mirrors = res.mirrors || [];
    plugState.mirrorsError = res.error || null;
    plugState.mirrorDraft = ""; // the field has taken what it was given
    plugState.mirrorResult = { ok: true, text: `${raw} is in your list: it is tried before the entries this build ships` };
  } else {
    // the list's own refusal, quoted: it says which list already has the entry
    plugState.mirrorResult = { ok: false, text: (res && res.error) || "no answer" };
  }
  renderPlugins();
}

async function plugMirrorRemove(url) {
  const api = window.clutchComponents;
  if (!api || !api.removeMirror || plugState.mirrorBusy) return;
  plugState.mirrorBusy = true;
  plugState.mirrorResult = null;
  renderPlugins();
  let res;
  try {
    res = await api.removeMirror(url);
  } catch (e) {
    res = { ok: false, error: (e && e.message) || String(e) };
  }
  plugState.mirrorBusy = false;
  if (res && res.ok) {
    plugState.mirrors = res.mirrors || [];
    plugState.mirrorsError = res.error || null;
    plugState.mirrorResult = { ok: true, text: `${url} is no longer tried` };
  } else {
    plugState.mirrorResult = { ok: false, text: (res && res.error) || "no answer" };
  }
  renderPlugins();
}

// Ask, then write. The question names the place and states the one fact the
// page must not hide (the write cannot be undone from here), and the answer is
// either an install that was actually started or nothing at all.
async function plugInstall(entry) {
  const api = window.clutchComponents;
  if (!api || plugState.busy || entry.problem) return; // no place, no write
  if (!plugPlaceUnread(entry) && plugPlaceReady(entry.place)) return; // and no unreachable one either
  const where = plugPlaceName(entry);
  const held = plugState.held ? plugState.held.find((h) => h.name === entry.name) : null;
  const read = plugPlaceUnread(entry) ? "" : plugPlaceUnknown(entry.place);
  const knows = read ? ` Whether ${where} already holds it could not be read.` : "";
  const again = held ? ` It already holds ${held.version}; installing rewrites that same version.` : "";
  const go = await askConfirm({
    title: `Install ${entry.name}?`,
    text:
      `${entry.name}${entry.version ? " " + entry.version : ""} is written into the component directory on ${where}.` +
      " It can be removed again from this page, but a removal DELETES bytes: nothing here keeps a copy," +
      " so neither act is a rollback." +
      again +
      knows,
    ok: "Install",
  });
  if (!go) return;
  plugState.busy = { name: entry.name, stage: "starting", place: entry.place };
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
  // the answer names the place the bytes actually landed on: an install that read
  // an unread declaration can say more than the row it was asked from
  plugState.result = plugInstallResult(entry, res, res && res.place ? plugPlace({ place: res.place }) : where);
  renderPlugins();
  // an inventory just changed: read it back. The market is cached
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
  // the note is the PAGE's line now, not the log of a write: what a write is doing
  // and what the host answered are drawn on the row they are about (plugItemState),
  // so what is left here is what no row can say — this page's own reads. A read
  // that failed outranks everything (it is why the list is short), then a write
  // whose row is not on screen, then a read still running.
  const problem = plugReadProblem();
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
  // the mirrors are one more section of the same page, and only when this shell
  // has the channel for them: a build whose preload predates them draws the
  // components and says nothing about a list it cannot read
  if (window.clutchComponents.mirrors) plugBodyEl.appendChild(plugMirrors());
}

// Read all three halves, render each as it lands: the two inventories are two
// local calls, the market is ONE read (the index; a module's manifest is read
// when something is installed from it, and
// every read is a network hop that can take its time), and the mirror list is a
// read of two local files (ui/mirrors.js). A shell with no mirror channel — an
// older bridge — has two reads, not three with one that never lands.
function plugRead({ force = false } = {}) {
  const api = window.clutchComponents;
  if (!api || plugState.pending) return; // no channel, or a read already running
  plugState.sessionError = null;
  plugState.sessionHeldError = null;
  plugState.clientError = null;
  plugState.clientHeldError = null;
  plugState.marketError = null;
  plugState.mirrorsError = null;
  const mirrors = api.mirrors ? api.mirrors() : null;
  plugState.pending = mirrors ? 3 : 2;
  renderPlugins();
  api
    .list()
    .then((r) => {
      plugState.sessionBase = r.sessionBase || "";
      // each half answers on its own, and the rows that DID arrive are drawn: a
      // place that could not be read is not a place holding nothing, and an empty
      // list is exactly the reading this page must not give
      plugState.sessionError = r.error || null;
      plugState.sessionHeldError = r.inventoryError || null;
      plugState.client = Boolean(r.client);
      plugState.clientError = r.clientError || null;
      plugState.clientHeldError = r.clientInventoryError || null;
      plugState.held = Array.isArray(r.held) ? r.held : [];
      plugState.read = true;
    })
    .catch((e) => {
      plugState.sessionError = (e && e.message) || String(e);
      plugState.read = true;
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
  if (mirrors) {
    mirrors
      .then((m) => {
        plugState.mirrors = (m && m.mirrors) || [];
        // the list's own reason, when it could not be read at all (a file this
        // machine cannot open): the section says so instead of drawing "none"
        plugState.mirrorsError = (m && m.error) || null;
        plugState.mirrorForced = (m && m.forced) || "";
      })
      .catch((e) => {
        plugState.mirrors = null;
        plugState.mirrorsError = (e && e.message) || String(e);
      })
      .then(() => {
        plugState.pending--;
        renderPlugins();
      });
  }
}

// ---- the source mirror ------------------------------------------------------
//
// Where the reads this build makes are sent: the market index, a module's
// manifest, and the artifact a machine fetches. ui/net-fetch.js applies the prefix
// once, where a source becomes a URL, and the fetch that obeys it happens in the
// HOST process — this file cannot reach it, and on the phone the host's own
// artifact downloads read the same key — so this field is not the knob: it is the
// one door to it. Saving writes ~/.clutch/settings.json through clutchSettings
// (the same path the LLM knobs take), which is the only place mirrorPrefix() can
// read a mirror from on Android, where HOME is the app's own filesDir and the
// hand-written key the log line used to prescribe is not something a phone user
// can produce. localStorage is this window's own copy, kept only so the field
// comes back filled the next time the pane is opened — nothing reads it but this.
//
// The knob is a decision with a network consequence, so it is one deliberate act
// (the Save button, never the keystroke) and the line under it is the verdict:
// what the reads are sent through now, or why the value was refused.
function plugMirrorStored() {
  try {
    return localStorage.getItem("clutch_source_mirror") || "";
  } catch (e) {
    return ""; // a storage this window cannot read is a window with no mirror
  }
}

function plugMirrorNote(text, bad) {
  if (!plugMirrorNoteEl) return;
  plugMirrorNoteEl.className = "plug-mirror-note" + (bad ? " error" : "");
  plugMirrorNoteEl.textContent = text;
}

// What the line says when it is NOT the answer to a just-pressed Save: the mirror
// in force, said as the sentence the reads follow ("read under X" / "read from
// github.com") rather than as the value's own name for itself.
function plugMirrorIdleNote() {
  const cur = plugMirrorStored();
  plugMirrorNote(
    cur
      ? `the market index and every manifest are read under ${cur}`
      : "no mirror: the market index and every manifest are read from github.com",
    false
  );
}

// The save: one value, one write, one re-read. A value that is not http(s) is
// refused before anything is written — a mirror is the PREFIX of an http(s) URL, so
// anything else would rewrite every source into something that is not a URL and
// the page would then report a network failure for what is a typo. The host writes
// first and localStorage second: a copy that outlived a refused write would fill
// the field with a mirror this window is not actually reading under.
async function plugMirrorSave() {
  const raw = plugMirrorInput ? plugMirrorInput.value.trim() : "";
  if (raw && !/^https?:\/\//i.test(raw)) {
    plugMirrorNote(
      `"${raw}" is not http(s): a mirror is the prefix a source URL is read under, so it has to be a URL too — nothing was written`,
      true
    );
    return;
  }
  const value = raw.replace(/\/+$/, ""); // "<mirror>" and "<mirror>/" are one mirror
  const api = window.clutchSettings;
  if (!api || !api.save) {
    plugMirrorNote("this shell cannot write the setting", true);
    return;
  }
  if (plugMirrorSaveBtn) plugMirrorSaveBtn.disabled = true;
  let reply = null;
  try {
    reply = await api.save({ source_mirror: value });
  } catch (e) {
    reply = { ok: false, error: (e && e.message) || String(e) };
  }
  if (plugMirrorSaveBtn) plugMirrorSaveBtn.disabled = false;
  if (reply && reply.ok === false) {
    plugMirrorNote(`could not save the mirror: ${(reply && reply.error) || "the host refused it"}`, true);
    return;
  }
  try {
    localStorage.setItem("clutch_source_mirror", value);
  } catch (e) {
    /* a window that cannot remember it still reads under it for this session */
  }
  plugMirrorNote(
    value
      ? `the market index and every manifest are now read under ${value} — every digest is still checked against the release's own pin`
      : "no mirror: the market index and every manifest are read from github.com again",
    false
  );
  // the mirror moves where the BYTES come from, so the list has to be read again:
  // a read that could not be reached a moment ago may answer now
  plugState.result = null;
  plugRead({ force: true });
}

if (plugMirrorInput) plugMirrorInput.value = plugMirrorStored();
if (plugMirrorSaveBtn) plugMirrorSaveBtn.addEventListener("click", plugMirrorSave);
plugMirrorIdleNote();

plugReloadBtn.addEventListener("click", () => {
  plugState.result = null; // a reload is a request for facts, not a report to keep
  plugRead({ force: true });
});
// the tab is the entry point: opening it is what makes the page go and look
$("#settings-tab-plugins").addEventListener("click", () => pluginTabShown());

function pluginTabShown() {
  plugRead();
}

// Whether the plugins pane is the one on screen: the modal is open and its tab is
// the one selected (ui/js/settings.js owns both, ui/index.html draws them).
function plugPaneVisible() {
  const pane = $("#settings-pane-plugins");
  const box = $("#settings-modal");
  if (!pane || !box) return false;
  return !pane.classList.contains("hidden") && !box.classList.contains("hidden");
}

// A session that MOVES is a different session machine, so what the session half of
// this list holds is stale the moment the backend base changes — a tunnel that
// just came up, a window re-bound to another host, a hop back after an outage. The
// client half does not care, and neither does an untouched page: only a pane
// somebody is looking at is read again, because a hidden one would spend a network
// read on nothing (the same discipline as the mirror list above).
if (window.clutchApi && window.clutchApi.onBaseChanged) {
  window.clutchApi.onBaseChanged(() => {
    if (!plugPaneVisible()) return;
    // the market did not move with the session (a release list) and neither did
    // this client plugin domain: only the two inventories are re-read, and the
    // market comes back from its own cache
    plugState.result = null;
    plugRead();
  });
}

// ...and the other direction of the same fact: a tunnel that ENDS takes the
// session machine with it, whether or not the host re-binds this window to a local
// session. A row that was the far machine is not that machine any more, and a page
// still drawing it would be the reported lie in reverse.
if (window.clutchTunnel && window.clutchTunnel.onEnd) {
  window.clutchTunnel.onEnd(() => {
    if (!plugPaneVisible()) return;
    plugState.result = null;
    plugRead();
  });
}

// The install runs in the main process (it holds the filesystem and the network);
// the stages come back as they happen, so a slow tunnel does not look like a
// frozen button. A stage for anything but the install this page started is
// ignored — this page is not the only window.
if (window.clutchComponents && window.clutchComponents.onProgress) {
  window.clutchComponents.onProgress((stage) => {
    if (!stage || !plugState.busy || stage.name !== plugState.busy.name) return;
    // the place travels with the stage: it is what every sentence in
    // `plugStageLine` says the step is happening on, and the main process never
    // chooses it — the declaration did, before the write started
    plugState.busy = {
      name: stage.name,
      stage: stage.stage,
      version: stage.version,
      prefix: stage.prefix || "",
      place: plugState.busy.place,
      verb: plugState.busy.verb,
    };
    renderPlugins();
  });
}
