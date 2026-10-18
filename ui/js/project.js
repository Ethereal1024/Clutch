// the open project — stream reset, history paging, open, create
//
// Clearing the pane for a new project, paging older events back in, and the
// open/create calls themselves.
//
// Load order is the contract: these are CLASSIC scripts (Electron loads the
// renderer over file://, where Chromium refuses module scripts), so this file
// sees every `const`/`let`/`function` the earlier files declared. It may rely
// on anything above it in ui/index.html and on nothing below it.

"use strict";

let currentProject = ""; // path of the active .clc project file

function clearStream() {
  eventsEl.innerHTML = ""; // clear session content; the overlay/events wrapper stay mounted
  lastTextEl = null;
  lastTextContent = "";
  thinkingEl = null;
  thinkingContent = "";
  if (textRenderRaf) { cancelAnimationFrame(textRenderRaf); textRenderRaf = 0; }
  if (thinkingRenderRaf) { cancelAnimationFrame(thinkingRenderRaf); thinkingRenderRaf = 0; }
  compactionEl = null;
  retryNoteEl = null;
  oldestOffset = null; // fresh project: no loaded events yet
  streamHighOffset = null; // and no replayed record to dedupe a reconnect against
  runSettled = false; // a fresh pane holds no run's ending (js/stream-events.js)
  resetRollbackAnchors(); // and no journal anchors: they belong to the project that left
  setOlderPill(0);
}

// ---- scroll-up paging (lazily-opened projects) ----
// olderRemaining mirrors the server's on-disk count, so a dropped page
// never makes the pill lie
let olderRemaining = 0;
let oldestOffset = null; // byte offset of the oldest loaded (rendered) non-task event
// byte offset of the NEWEST rendered event: a reconnecting stream replays the
// window from its start, and everything at or below this is a record this window
// already painted (addEvent in js/stream-events.js). Reset with the pane.
let streamHighOffset = null;
let paging = false;   // one history fetch at a time
// what the pill is waiting on: "" (offering the page), "fetch" (the request is
// out) or "render" (the reply is here and the pane is taking it). A `history`
// frame that lands mid-page reads this instead of overwriting the wait.
let olderBusy = "";
// when non-null, addEvent appends into this off-DOM sink instead of #events
let pageSink = null;

// The page's size as a person reads it: the pill offers it, and names it again
// while it is being fetched.
function olderSizeLabel(bytes) {
  const kb = Math.max(1, Math.ceil(bytes / 1024));
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

// The pill's one label, in all three states. It is painted from `olderBusy`, so a
// reconnecting stream's `history` frame (js/stream-events.js setOlderPill) mid-page
// rewrites the same sentence instead of taking the spinner's place.
function paintOlderLabel() {
  const label = document.getElementById("older-label");
  if (!label) return;
  const size = olderSizeLabel(olderRemaining);
  if (olderBusy === "render") label.textContent = "rendering earlier records…";
  else if (olderBusy === "fetch") label.textContent = `loading ${size}…`;
  else label.textContent = `load earlier records (${size})`;
}

function setOlderPill(n) {
  olderRemaining = Math.max(0, n | 0);
  const pill = document.getElementById("older-pill");
  if (olderRemaining > 0) {
    pill.classList.remove("hidden");
    paintOlderLabel();
  } else {
    pill.classList.add("hidden");
  }
}

// The tap has to be answered on the frame it lands. A page is ONE /api/history
// request whose budget is a megabyte and a turn (below), the server assembles it
// from disk, and the prepend that follows is one synchronous pass over the reply —
// so the wait is spent inside the control that was just pressed: a ring, the number
// being fetched, and `aria-busy` for assistive tech. Cleared in loadOlder's
// `finally`, whatever the outcome.
function setOlderBusy(stage) {
  olderBusy = stage || "";
  const pill = document.getElementById("older-pill");
  if (!pill) return;
  pill.classList.toggle("busy", !!olderBusy);
  if (olderBusy) pill.setAttribute("aria-busy", "true");
  else pill.removeAttribute("aria-busy");
  paintOlderLabel();
}

// One PAINTED frame: the first rAF only promises the browser is about to paint.
// Used to put the reply's own state on screen before the synchronous prepend takes
// the main thread — otherwise the label would change and then freeze unseen.
function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function loadOlder() {
  if (paging || stream.classList.contains("loading") || !oldestOffset || olderRemaining <= 0) return;
  paging = true;
  setOlderBusy("fetch"); // synchronous: this is the frame the tap lands on
  try {
    const anchor = eventsEl.firstElementChild; // identity survives the prepend
    // A page is a BYTE budget, and a byte budget splits turns: the median finished
    // turn in a real project is ~278 KB (ui-fix.clc), so a 256 KiB page cut one
    // nearly every time. Two things follow from that. `limit` is now ~2 turns'
    // worth, and `align=turn` has the server walk the page's start back to the task
    // row that opens the turn the budget cut (agent/core/lazy.py aligned_start) —
    // a page then begins where a turn begins, and the pane is handed whole turns.
    const data = await apiFetch(`/api/history?before=${oldestOffset}&limit=1048576&align=turn`, { timeout: 60000 });
    const page = data.events || [];
    if (!page.length) { setOlderPill(0); return; }
    // What follows is one synchronous pass (the sink render below, the prepend, the
    // folds), so the reply's own stage is painted first. Nothing has moved yet:
    // `pageSink` is not set and `oldestOffset` is not read again, so a live frame
    // that lands in this yield renders into the pane exactly as it always would.
    setOlderBusy("render");
    await nextPaint();
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
    // render the page through the full replay pipeline into an off-DOM sink,
    // then prepend it in one pass; save/restore live-stream state
    const sink = document.createElement("div");
    sink.style.display = "contents"; // transparent wrapper: children lay out in #events
    const savedLastTextEl = lastTextEl, savedLastTextContent = lastTextContent;
    const savedThinkingEl = thinkingEl, savedThinkingContent = thinkingContent;
    const savedToolGroupEl = toolGroupEl;
    lastTextEl = null; lastTextContent = "";
    thinkingEl = null; thinkingContent = "";
    toolGroupEl = null;
    pageSink = sink;
    try {
      for (const item of page) addEvent(item); // unwrap tracks oldestOffset
    } finally {
      pageSink = null;
      lastTextEl = savedLastTextEl; lastTextContent = savedLastTextContent;
      thinkingEl = savedThinkingEl; thinkingContent = savedThinkingContent;
      toolGroupEl = savedToolGroupEl;
    }
    // typeset AFTER insertion: MathJax needs real layout
    const mathBlocks = Array.from(sink.querySelectorAll(".event.text .body, .event.user .body")).filter(hasMathText);
    const frag = document.createDocumentFragment();
    while (sink.firstChild) frag.appendChild(sink.firstChild);
    eventsEl.insertBefore(frag, eventsEl.firstElementChild);
    // This page can carry the end of a turn this window opened in the middle of: a
    // compaction fired mid-run, so the window's first region is a turn whose task
    // row is older than the window (agent/core/lazy.py cpr_start). Its `final`
    // arrived while the sink was the render target — where folding is refused,
    // because the pane is about to be handed those rows (js/auto-fold.js) — so it
    // is folded now, on the prepended pane and before anything paints. Announced by
    // name, not called: js/auto-fold.js loads after this file and a classic script
    // may only name what the files above it declared (tests/ui-load-order-test.js).
    eventsEl.dispatchEvent(new CustomEvent("clutch:page-prepended"));
    if (typeof MathJax !== "undefined" && typeof MathJax.typesetPromise === "function") {
      for (const b of mathBlocks) {
        try { await MathJax.typesetPromise([b]); } catch (e) {}
        await new Promise((r) => setTimeout(r, 0)); // repaint between blocks
      }
    }
    // prepending (and typesetting) shifted the content down: re-anchor the view on
    // the row that was on top. That row can now be inside a fold the line above
    // just closed, and a hidden row has no box — its rect reads zero, which would
    // throw the scroll position — so anchor on the fold that holds it instead: the
    // fold's head sits exactly where that row was.
    if (anchor && anchorTop !== null) {
      const onTop = anchor.getClientRects().length ? anchor : anchor.closest(".turn-fold");
      if (onTop) stream.scrollTop += onTop.getBoundingClientRect().top - anchorTop;
    }
    setOlderPill(data.older);
  } catch (e) {
    notice("Failed to load earlier records: " + e.message);
  } finally {
    paging = false;
    setOlderBusy(""); // the pill goes back to offering the page (or hides at 0)
  }
}

// The pill is the only way back to older records, and it is wired here with the
// paging state it reads — it used to be registered from the settings block,
// which only worked while the whole renderer was one file.
$("#older-pill").addEventListener("click", loadOlder);

function setProjectInfo(info) {
  currentProject = info.project || "";
  els.projectLabel.textContent = info.name || "";
  els.projectLabel.title = currentProject;
  if (info.workdir) els.workspace.textContent = info.workdir;
  // read-only badge: visible only while the active project is read-only
  const badge = document.getElementById("readonly-badge");
  if (badge) badge.classList.toggle("hidden", !info.read_only);
  setStatus("idle");
}

function hideWelcome() {
  document.getElementById("welcome").classList.add("hidden");
  els.run.disabled = busy || !currentProject;
}

async function openProject(path, readOnly = false) {
  // a run keeps the write lock on the project it is appending to; say so out
  // loud instead of swallowing the tap
  if (busy) {
    notice("a run is active — stop it before opening another project");
    return;
  }
  const prog = document.getElementById("open-progress");
  const fill = prog.querySelector(".open-progress-fill");
  const label = prog.querySelector(".open-progress-label");
  const setPct = (pct) => {
    fill.style.width = pct + "%";
    label.textContent = Math.round(pct) + "%";
  };
  try {
    // NOT apiFetch: this endpoint streams NDJSON (meta/progress/event/done), so
    // the body must stay a stream; only the error unwrap below shares apiFetch's
    // contract (Error with .code/.status)
    if (!API_BASE) throw noBackend(); // never fetch "null/api/project/open"
    const r = await fetch(API_BASE + "/api/project/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...(readOnly ? { read_only: true } : {}) }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const e = new Error(err.error || r.status);
      e.code = err.code || null; // e.g. project_open_conflict (HTTP 409)
      throw e;
    }
    clearStream();
    stream.classList.add("loading"); // history reconstruction: no entrance motion
    prog.classList.remove("hidden");
    setPct(0);
    // /api/project/open streams NDJSON: meta, progress, event, done
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let started = false;
    let processed = 0;
    let totalEvents = 0;
    let rendered = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { console.warn("[openProject] undecodable line", e); continue; }
        if (msg.error) {
          const e = new Error(msg.error);
          e.code = msg.code || null;
          throw e;
        }
        if (msg.meta) {
          setProjectInfo({
            project: msg.meta.project,
            name: msg.meta.name,
            workdir: msg.meta.workdir,
            read_only: !!msg.meta.read_only,
          });
          hideWelcome();
          started = true;
        } else if (msg.count) {
          totalEvents = msg.count;
          // lazy open: "older" = durable records still on disk before the loaded tail
          if (typeof msg.older === "number") setOlderPill(msg.older);
        } else if (msg.progress && msg.progress.total) {
          // phase A: server file parse maps to the first 50% of the bar
          setPct(50 * msg.progress.done / msg.progress.total);
        } else if (msg.event) {
          // {offset, event}: addEvent unwraps and tracks the oldest loaded offset
          addEvent(msg);
          // phase B: client rendering of the events maps to 50-90%
          if (totalEvents) setPct(50 + 40 * (++rendered / totalEvents));
        }
        // yield periodically so the browser paints the bar and streams events progressively
        if (++processed % 25 === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    // phase C: typeset replayed math as the remaining 90-100%
    await typesetProgressively(eventsEl, (f) => setPct(90 + 10 * f));
    if (started) setPct(100);
    prog.classList.add("hidden");
    stream.classList.remove("loading"); // instant reveal — no fade, no replay
    stream.scrollTop = stream.scrollHeight; // jump straight to the end of the record
    // re-scope the live stream to the new project; the watermark (streamHighOffset)
    // now holds this project's tail, so the stream resumes exactly there
    reconnectSSE();
    refreshTree();
    refreshRollbackAnchors(); // the rows just replayed can be rolled back; ask the journal
  } catch (e) {
    prog.classList.add("hidden");
    stream.classList.remove("loading");
    // same project open for write in another window: offer read-only instead of failing
    if (e && e.code === "project_open_conflict") {
      const wantReadOnly = await askConfirm({
        title: "Already open elsewhere",
        text:
          "This project is already open in another window.\n" +
          "Open it read-only? Read-only mode cannot run tasks.",
        ok: "Open read-only",
      });
      if (wantReadOnly) {
        await openProject(path, true); // retry without the write lock
        return;
      }
      return; // cancelled: keep the previous project as-is
    }
    notice("Failed to open project: " + e.message);
    // a network "Failed to fetch" usually means the remote session forward died
    console.error("[openProject] failed:", { api: API_BASE, path, error: e && e.message });
  }
}

async function createProject(dir, name) {
  if (busy) {
    notice("a run is active — stop it before creating a project");
    return;
  }
  try {
    const data = await apiFetch("/api/project/new", { method: "POST", body: { dir, name } });
    clearStream();
    setProjectInfo(data);
    hideWelcome();
    reconnectSSE(); // new empty project: the watermark resets with the stream
    refreshTree();
    refreshRollbackAnchors(); // a fresh project has an empty journal; keep the set honest
  } catch (e) {
    notice("Failed to create project: " + e.message);
  }
}

