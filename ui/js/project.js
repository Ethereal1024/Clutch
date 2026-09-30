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
  compactionEl = null;
  retryNoteEl = null;
  oldestOffset = null; // fresh project: no loaded events yet
  setOlderPill(0);
}

// ---- scroll-up paging (lazily-opened projects) ----
// olderRemaining mirrors the server's on-disk count, so a dropped page
// never makes the pill lie
let olderRemaining = 0;
let oldestOffset = null; // byte offset of the oldest loaded (rendered) non-task event
let paging = false;   // one history fetch at a time
// when non-null, addEvent appends into this off-DOM sink instead of #events
let pageSink = null;

function setOlderPill(n) {
  olderRemaining = Math.max(0, n | 0);
  const pill = document.getElementById("older-pill");
  if (olderRemaining > 0) {
    pill.classList.remove("hidden");
    const kb = Math.max(1, Math.ceil(olderRemaining / 1024));
    const label = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
    document.getElementById("older-label").textContent =
      `load earlier records (${label})`;
  } else {
    pill.classList.add("hidden");
  }
}

async function loadOlder() {
  if (paging || stream.classList.contains("loading") || !oldestOffset || olderRemaining <= 0) return;
  paging = true;
  try {
    const anchor = eventsEl.firstElementChild; // identity survives the prepend
    const data = await apiFetch(`/api/history?before=${oldestOffset}&limit=262144`, { timeout: 60000 });
    const page = data.events || [];
    if (!page.length) { setOlderPill(0); return; }
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
    if (typeof MathJax !== "undefined" && typeof MathJax.typesetPromise === "function") {
      for (const b of mathBlocks) {
        try { await MathJax.typesetPromise([b]); } catch (e) {}
        await new Promise((r) => setTimeout(r, 0)); // repaint between blocks
      }
    }
    // prepending (and typesetting) shifted the content down: re-anchor the view
    if (anchor && anchorTop !== null) {
      stream.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }
    setOlderPill(data.older);
  } catch (e) {
    notice("Failed to load earlier records: " + e.message);
  } finally {
    paging = false;
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
    // re-scope the live stream to the new project; replay=0 (history already rendered)
    reconnectSSE(false);
    refreshTree();
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
    reconnectSSE(false); // new empty project: nothing to replay, just live events
    refreshTree();
  } catch (e) {
    notice("Failed to create project: " + e.message);
  }
}

