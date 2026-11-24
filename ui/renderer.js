// GENERATED FILE — do not edit; edit ui/src/renderer/*.ts and run `npm run build`.
// sources sha256: 46c5dfd07514b14f25a20c4f37b22723fa320b3a14ec918480dc825577610e10
// Entry: src/renderer/boot.ts — its imports are the load order.
(() => {
  // src/renderer/bridge-shim.ts
  (function() {
    "use strict";
    const root = typeof window !== "undefined" ? window : globalThis;
    function expose(name, api) {
      if (!root[name]) root[name] = api;
    }
    function resolveBase() {
      if (root.CLUTCH_BRIDGE_BASE) return String(root.CLUTCH_BRIDGE_BASE).replace(/\/+$/, "") + "/";
      try {
        const script = root.document && root.document.currentScript;
        const q = script && script.src && new URL(script.src).searchParams.get("bridge");
        if (q) return String(q).replace(/\/+$/, "") + "/";
      } catch (e) {
      }
      return "http://127.0.0.1:8899/";
    }
    const base = resolveBase();
    function argsOf(args) {
      const out = args || [];
      let n = out.length;
      while (n > 0 && out[n - 1] === void 0) n--;
      return out.slice(0, n);
    }
    async function call(ns, method, args = []) {
      let r, d;
      try {
        r = await fetch(base + "api/" + ns + "/" + method, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(argsOf(args))
        });
        d = await r.json();
      } catch (e) {
        throw new Error("bridge unreachable (" + ns + "." + method + "): " + (e && e.message || e));
      }
      if (!d || d.ok !== true) {
        throw new Error(d && d.error || "bridge call failed: " + ns + "." + method);
      }
      return d.result;
    }
    const listeners3 = /* @__PURE__ */ new Map();
    let stream2 = null;
    function ensureStream() {
      if (stream2) return;
      stream2 = new EventSource(base + "events");
      stream2.onmessage = (m) => {
        let d;
        try {
          d = JSON.parse(m.data);
        } catch (e) {
          console.error("[bridge-shim] dropped an event frame that is not JSON (" + (e && e.message || e) + "):", m.data);
          return;
        }
        const set = listeners3.get(d.event);
        if (!set) return;
        for (const cb of [...set]) {
          try {
            cb.apply(null, d.args || []);
          } catch (e) {
          }
        }
      };
    }
    function subscribe(channel, cb) {
      ensureStream();
      let set = listeners3.get(channel);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        listeners3.set(channel, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    }
    expose("clutchApi", {
      // the slotId names one tab's session (absent = the window's default slot)
      baseUrl: (slotId) => call("clutchApi", "baseUrl", [slotId]),
      slotStatus: (slotId) => call("clutchApi", "slotStatus", [slotId]),
      // this window leaving its session (the conn-lost dialog's Cancel). The host
      // knows which window is asking — on the phone there is exactly one — so the
      // bridge route takes no window id and the renderer cannot name another one.
      // The slotId only names WHICH of this page's sessions is leaving.
      releaseSession: (slotId) => call("clutchApi", "releaseSession", [slotId]),
      // per-slot backend target (the picker's pin): the same two verbs the desktop
      // preload exposes, so a page on the bridge can name the device its next
      // claim should use. A bridge host that does not implement them rejects the
      // call, exactly as any other route it does not serve.
      setSlotTarget: (slotId, target) => call("clutchApi", "setSlotTarget", [slotId, target]),
      getSlotTarget: (slotId) => call("clutchApi", "getSlotTarget", [slotId]),
      onBaseChanged: (cb) => subscribe("backend:base-changed", cb)
    });
    expose("clutchSettings", {
      save: (data) => call("clutchSettings", "save", [data]),
      // rebuild the ~/.clutch/settings.json mirror when it is missing (self-heal)
      ensure: (data) => call("clutchSettings", "ensure", [data])
    });
    function runArgs(slotOrPayload, maybePayload) {
      if (typeof slotOrPayload === "string") return [slotOrPayload, maybePayload];
      return ["", slotOrPayload];
    }
    expose("clutchRun", {
      start: (slotId, payload) => call("clutchRun", "start", runArgs(slotId, payload)),
      run: (slotId, payload) => call("clutchRun", "run", runArgs(slotId, payload)),
      stop: (slotId) => call("clutchRun", "stop", [slotId]),
      step: (slotId) => call("clutchRun", "step", [slotId]),
      drive: (slotId) => call("clutchRun", "drive", [slotId]),
      state: (slotId, payload) => call("clutchRun", "state", runArgs(slotId, payload)),
      onEvent: (cb) => subscribe("run:event", cb)
    });
    expose("clutchComponents", {
      list: () => call("clutchComponents", "list"),
      market: (opts) => call("clutchComponents", "market", [opts]),
      install: (name) => call("clutchComponents", "install", [name]),
      versions: (name) => call("clutchComponents", "versions", [name]),
      remove: (name, opts) => call("clutchComponents", "remove", [name, opts]),
      setDisabled: (name, disabled) => call("clutchComponents", "setDisabled", [name, disabled]),
      settings: (name) => call("clutchComponents", "settings", [name]),
      setSetting: (name, values) => call("clutchComponents", "setSetting", [name, values]),
      mirrors: () => call("clutchComponents", "mirrors"),
      addMirror: (url) => call("clutchComponents", "addMirror", [url]),
      removeMirror: (url) => call("clutchComponents", "removeMirror", [url]),
      onProgress: (cb) => subscribe("components:progress", cb)
    });
    expose("clutchUpdate", {
      check: (current) => call("clutchUpdate", "check", [current]),
      download: () => call("clutchUpdate", "download"),
      install: (file) => call("clutchUpdate", "install", [file]),
      onProgress: (cb) => subscribe("update:progress", cb)
    });
    expose("clutchTunnel", {
      connect: (cfg) => call("clutchTunnel", "connect", [cfg]),
      status: () => call("clutchTunnel", "status"),
      disconnect: () => call("clutchTunnel", "disconnect"),
      // the devices this host knows (connected or recently connected), for the
      // picker that parks a tab on one of them
      list: () => call("clutchTunnel", "list"),
      onEnd: (cb) => subscribe("tunnel:ended", cb),
      onProgress: (cb) => subscribe("tunnel:progress", cb)
    });
  })();

  // src/renderer/dom.ts
  var $ = (s) => document.querySelector(s);

  // src/renderer/els.ts
  var els = {
    task: $("#task-input"),
    run: $("#run-btn"),
    mode: $("#mode-btn"),
    trust: $("#trust-btn"),
    claim: $("#claim-pill"),
    status: $("#status"),
    tree: $("#tree"),
    workspace: $("#sb-workdir")
  };
  var stream = $("#stream");
  var eventsEl = document.getElementById("events");

  // src/renderer/env.ts
  var agentMode = localStorage.getItem("clutch_mode") || "work";
  var IS_ANDROID = /\bAndroid\b/.test(navigator.userAgent || "");
  function setMode(mode) {
    agentMode = mode === "chat" ? "chat" : "work";
    localStorage.setItem("clutch_mode", agentMode);
    els.mode.textContent = agentMode;
    els.mode.classList.toggle("chat-mode", agentMode === "chat");
    els.mode.title = agentMode === "chat" ? "chat: read-only analysis \xB7 click for work mode (full access). Applies to the next run." : "work: full access \xB7 click for chat mode (read-only analysis). Applies to the next run.";
  }

  // src/renderer/state.ts
  var state = {
    // ---- tab-bar.ts / slots.ts ----
    // One entry per tab. `id` is ALSO the tab's session slot: the host claims one
    // supervisor session per id, which is what lets two tabs run at once.
    tabs: [],
    activeTabId: null,
    // ---- app.ts ----
    // the session base this window talks to; null until resolveApiBase() has an
    // answer, and null again when the session goes away (js/backend-lifecycle.ts)
    apiBase: null,
    // ---- tool-render.ts ----
    // the HOST's own default `ui` block (GET /api/host), fetched once at boot:
    // host.json may override any compiled-in constant, and the constants stay as
    // the fallback for a host that predates the endpoint (js/boot.ts sets this).
    hostUiDefaults: null,
    // ---- conn-flow.ts ----
    // the pending answer of the SSH password prompt (conn-flow.ts resolves it)
    passResolve: null,
    // every listing request takes the next token; an answer whose token is stale
    // (a newer request went out, fs-browser.ts) must not paint
    fsListToken: 0,
    // ---- project.ts ----
    // byte offset of the oldest loaded (rendered) non-task event
    oldestOffset: null,
    // the highest offset this window has painted; everything at or below it is a
    // record it already rendered. Reset with the pane.
    streamHighOffset: null,
    // ---- sse-stream.ts ----
    // a run is in flight and the stream is at risk (a backend switch or a lost
    // link mid-run): the ring predicts a reconnect instead of a fresh turn
    sseRunAtRisk: false,
    // the stream dropped mid-run and nobody has asked the host whether the run
    // survived; asked once, answered once (js/stream-events.ts clears it)
    sseRunLostPending: false,
    // the run this window was watching has ended (painted its ending already)
    runSettled: false,
    // ---- stream-events.ts ----
    // the paint work a catch-up (`history` … `replayed`) has queued but not run:
    // the block is DATA until the server closes it, and its closing frame paints
    // the whole block in one task — a tunnel delivers each record in its own SSE
    // frame, so a paint per frame is a paint per record (the reported "a pile of
    // messages loads itself" / "一次性闪过很多消息"). Each entry is the thunk that
    // renders one record; settleCatchUp() runs them and closes the bracket, and
    // every way the block can end goes through it (the watermark already counts
    // these rows, so a dropped one would never be asked for again).
    owedRecords: [],
    // ---- stream-text.ts ----
    // the coalesced-render frame handles: a token arrives, the frame repaints
    textRenderRaf: 0,
    thinkingRenderRaf: 0,
    // ---- stream-view.ts ----
    // latched tail-follow: reaching the bottom (or ↓) pins the view; only a user's
    // upward scroll breaks the latch
    followTail: true,
    // ignore latch changes ~120ms after the input box resizes: the clamp scroll
    // event can fire before the shrunken viewport is observable
    suppressLatchUntil: 0,
    // the most recent agent text block (created by streaming text_delta)
    lastTextEl: null,
    lastTextContent: "",
    // that block is CLOSED and takes no more deltas: either it holds a durable
    // assistant_message's text, which is the whole of that model step's prose (a
    // text_delta still arriving for the same step is a copy of what the block already
    // says — the delta feed and the log's own SSE feed are unordered), or a cut ended
    // it and only the record that owns it may write it now (stream-events.ts)
    textSealed: false,
    // The block the pane DREW for the newest durable assistant_message, and the text
    // it holds. A record no live block adopts paints a block of its own — a STORED
    // session (no deltas at all), a replayed transcript, a tail a restored tab
    // rebuilt. The run's `final` repeats exactly that record's text (run-state.ts
    // foldRun closes a completed turn by writing its last assistant_message as the
    // summary), so it has to complete THIS block; painting a block of its own is the
    // reported "one answer, twice" (stream-events.ts).
    lastRecordEl: null,
    lastRecordText: "",
    // the thinking (reasoning) block
    thinkingEl: null,
    thinkingContent: "",
    // live "compressing context" block (compaction_delta)
    compactionEl: null,
    // live "reconnecting…" chip (llm_retry), removed once the stream resumes
    retryNoteEl: null,
    // the block currently collecting consecutive tool_calls (for merging)
    toolGroupEl: null
  };

  // src/renderer/diagram-viewer.ts
  var dvOverlay = null;
  var dvStage = null;
  var dvInner = null;
  var dvZoom = 1;
  var dvX = 0;
  var dvY = 0;
  var dvFitZoom = 1;
  var dvHistoryEntry = false;
  var DV_MIN_ZOOM = 0.05;
  var DV_MAX_ZOOM = 16;
  var clampZoom = (z) => Math.max(DV_MIN_ZOOM, Math.min(DV_MAX_ZOOM, z));
  function dvApply() {
    dvInner.style.transform = "translate(" + dvX + "px," + dvY + "px) scale(" + dvZoom + ")";
  }
  function dvFit() {
    const svg = dvInner.firstElementChild;
    if (!svg || !dvStage) return;
    const w = Number(svg.getAttribute("width")) || svg.clientWidth || 800;
    const h = Number(svg.getAttribute("height")) || svg.clientHeight || 600;
    const r = dvStage.getBoundingClientRect();
    dvFitZoom = Math.min(r.width * 0.94 / w, r.height * 0.94 / h) || 1;
    dvZoom = dvFitZoom;
    dvX = (r.width - w * dvZoom) / 2;
    dvY = (r.height - h * dvZoom) / 2;
    dvApply();
  }
  function dvZoomAt(factor, cx, cy) {
    const z = clampZoom(dvZoom * factor);
    const k = z / dvZoom;
    dvX = cx - (cx - dvX) * k;
    dvY = cy - (cy - dvY) * k;
    dvZoom = z;
    dvApply();
  }
  function dvCenterZoom(z) {
    if (!dvStage) return;
    const r = dvStage.getBoundingClientRect();
    dvZoomAt(z / dvZoom, r.width / 2, r.height / 2);
  }
  function ensureDiagramViewer() {
    if (dvOverlay) return;
    dvOverlay = document.createElement("div");
    dvOverlay.className = "diagram-viewer";
    dvOverlay.innerHTML = '<div class="dv-hint">drag to pan \xB7 pinch or wheel to zoom \xB7 double-tap for 1:1 \xB7 tap outside to close</div><div class="dv-stage"><div class="dv-inner"></div></div><div class="dv-bar"><button class="dv-zoom-out" title="zoom out">\u2212</button><button class="dv-one" title="actual size">1:1</button><button class="dv-fit" title="fit to screen">fit</button><button class="dv-zoom-in" title="zoom in">\uFF0B</button></div><button class="dv-close" title="close (Esc)">\u2715</button>';
    document.body.appendChild(dvOverlay);
    dvStage = dvOverlay.querySelector(".dv-stage");
    dvInner = dvOverlay.querySelector(".dv-inner");
    const localOf = (e) => {
      const r = dvStage.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    dvOverlay.querySelector(".dv-close").addEventListener("click", closeDiagramViewer);
    dvOverlay.querySelector(".dv-fit").addEventListener("click", dvFit);
    dvOverlay.querySelector(".dv-one").addEventListener("click", () => dvCenterZoom(1));
    dvOverlay.querySelector(".dv-zoom-in").addEventListener("click", () => dvCenterZoom(dvZoom * 1.5));
    dvOverlay.querySelector(".dv-zoom-out").addEventListener("click", () => dvCenterZoom(dvZoom / 1.5));
    dvStage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = localOf(e);
        dvZoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
      },
      { passive: false }
    );
    const pts = /* @__PURE__ */ new Map();
    let pinch = null;
    let moved = 0;
    const startPinch = () => {
      const [a, b] = [...pts.values()];
      return {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom: dvZoom,
        x: dvX,
        y: dvY,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      };
    };
    dvStage.addEventListener("pointerdown", (e) => {
      if (dvStage.setPointerCapture) dvStage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, localOf(e));
      moved = 0;
      if (pts.size === 2) pinch = startPinch();
    });
    dvStage.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const q = localOf(e);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      moved += Math.abs(dx) + Math.abs(dy);
      pts.set(e.pointerId, q);
      if (pts.size === 1) {
        dvX += dx;
        dvY += dy;
        dvApply();
        return;
      }
      if (!pinch) pinch = startPinch();
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = clampZoom(pinch.zoom * (dist / pinch.dist));
      const cx = (pinch.mid.x - pinch.x) / pinch.zoom;
      const cy = (pinch.mid.y - pinch.y) / pinch.zoom;
      dvZoom = z;
      dvX = mid.x - cx * z;
      dvY = mid.y - cy * z;
      dvApply();
    });
    const endPointer = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size || moved >= 8) return;
      const sr = dvStage.getBoundingClientRect();
      const r = dvInner.getBoundingClientRect();
      const p = localOf(e);
      const inside = p.x >= r.left - sr.left && p.x <= r.right - sr.left && p.y >= r.top - sr.top && p.y <= r.bottom - sr.top;
      if (!inside) closeDiagramViewer();
    };
    dvStage.addEventListener("pointerup", endPointer);
    dvStage.addEventListener("pointercancel", endPointer);
    dvStage.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (Math.abs(dvZoom - dvFitZoom) > 0.01) dvFit();
      else dvCenterZoom(1);
    });
  }
  function openDiagramViewer(source) {
    const svg = source.querySelector("svg");
    if (!svg) return;
    ensureDiagramViewer();
    const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const box = svg.getBoundingClientRect();
    const w = vb.length === 4 && vb[2] > 0 ? vb[2] : Math.round(box.width) || 800;
    const h = vb.length === 4 && vb[3] > 0 ? vb[3] : Math.round(box.height) || 600;
    const clone = svg.cloneNode(true);
    clone.removeAttribute("style");
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);
    clone.style.width = w + "px";
    clone.style.height = h + "px";
    clone.style.maxWidth = "none";
    while (dvInner.firstChild) dvInner.removeChild(dvInner.firstChild);
    dvInner.appendChild(clone);
    dvOverlay.classList.add("open");
    dvFit();
    if (!dvHistoryEntry) {
      try {
        history.pushState({ clutchDiagram: 1 }, "");
        dvHistoryEntry = true;
      } catch (e) {
        dvHistoryEntry = false;
      }
    }
  }
  function closeDiagramViewer() {
    if (!dvOverlay || !dvOverlay.classList.contains("open")) return;
    dvOverlay.classList.remove("open");
    while (dvInner.firstChild) dvInner.removeChild(dvInner.firstChild);
    if (dvHistoryEntry) {
      dvHistoryEntry = false;
      try {
        history.back();
      } catch (e) {
      }
    }
  }
  window.addEventListener("popstate", () => {
    if (dvHistoryEntry && dvOverlay && dvOverlay.classList.contains("open")) {
      dvHistoryEntry = false;
      dvOverlay.classList.remove("open");
      while (dvInner.firstChild) dvInner.removeChild(dvInner.firstChild);
    }
    dvHistoryEntry = false;
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDiagramViewer();
  });
  document.addEventListener("click", (e) => {
    const t = e.target;
    const pre = t && t.closest ? t.closest("pre.mermaid-rendered") : null;
    if (pre && pre.querySelector("svg")) openDiagramViewer(pre);
  });
  var CODE_LANGS = {
    py: "python",
    js: "javascript",
    mjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    html: "xml",
    htm: "xml",
    xml: "xml",
    css: "css",
    scss: "scss",
    json: "json",
    md: "markdown",
    sh: "bash",
    bash: "bash",
    yaml: "yaml",
    yml: "yaml",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    go: "go",
    rs: "rust",
    java: "java",
    sql: "sql",
    rb: "ruby",
    php: "php",
    r: "r",
    diff: "diff"
  };
  function highlightPreByPath(pre, path) {
    if (typeof hljs === "undefined") return;
    const ext = String(path || "").split(".").pop().toLowerCase();
    const lang = CODE_LANGS[ext] || "";
    if (lang) pre.classList.add("language-" + lang);
    try {
      if (pre.querySelector("code")) {
        hljs.highlightElement(pre.querySelector("code"));
      } else {
        const code = document.createElement("code");
        code.textContent = pre.textContent;
        pre.textContent = "";
        pre.appendChild(code);
        hljs.highlightElement(code);
      }
    } catch (e) {
    }
  }

  // src/renderer/fs-browser.ts
  var fsModal = $("#fs-modal");
  var fsMode = "open";
  var fsPath = "";
  var fsParent = null;
  var fsEntries = [];
  var fsNewFolder = null;
  var fsCreatedPath = "";
  var fsFirstLoad = true;
  var fsRows = [];
  function syncFilenameBar() {
    const name = fsMode === "new" ? "Project name" : "File name";
    $("#fs-filename-label").textContent = name;
    $("#fs-filename-input").placeholder = fsMode === "new" ? "my-project" : "name.clc or sub/path.clc";
  }
  function syncCreateAction() {
    if (fsMode !== "new") return;
    const value = $("#fs-filename-input").value.trim();
    $("#fs-create").disabled = !value || !fsPath;
  }
  function fsMkdirError(e) {
    const msg = String(e && e.message || e || "could not create the folder");
    const exists = /^already exists:\s*(.+)$/.exec(msg);
    return exists ? "a folder named " + exists[1] + " is already here" : msg;
  }
  function cancelNewFolder() {
    const nf = fsNewFolder;
    if (!nf) return;
    fsNewFolder = null;
    nf.row.remove();
  }
  function focusAfterNewFolder() {
    const first = fsRows[0];
    if (first) first.focus();
    else $("#fs-mkdir-btn").focus();
  }
  function beginNewFolder() {
    if (fsNewFolder) {
      if (fsNewFolder.busy) return;
      fsNewFolder.input.focus();
      return;
    }
    if (!fsPath) return;
    clearCreateOffer();
    const listEl = $("#fs-list");
    const row = document.createElement("div");
    row.className = "fs-row fs-edit-row";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "fs-inline-input";
    input.value = "";
    input.placeholder = "New folder";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "new folder name");
    const error = document.createElement("p");
    error.className = "fs-edit-error";
    error.setAttribute("role", "alert");
    row.appendChild(input);
    row.appendChild(error);
    const nf = { row, input, error, busy: false };
    fsNewFolder = nf;
    input.addEventListener("keydown", (e) => {
      if (nf.busy) return;
      if (e.key === "Enter") {
        e.preventDefault();
        commitNewFolder();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelNewFolder();
        focusAfterNewFolder();
      }
    });
    input.addEventListener("input", () => {
      row.classList.remove("fs-edit-row-error");
      error.textContent = "";
      input.removeAttribute("aria-invalid");
    });
    input.addEventListener("blur", (e) => {
      if (fsNewFolder === nf && !nf.busy) commitNewFolder(true, e.relatedTarget);
    });
    listEl.insertBefore(row, listEl.firstChild);
    listEl.scrollTop = 0;
    input.focus();
  }
  async function commitNewFolder(fromBlur = false, nextFocus = null) {
    const nf = fsNewFolder;
    if (!nf || nf.busy) return;
    const name = nf.input.value.trim();
    if (!name) {
      cancelNewFolder();
      if (!fromBlur) focusAfterNewFolder();
      return;
    }
    const dir = fsPath;
    const token = state.fsListToken;
    nf.busy = true;
    nf.row.setAttribute("aria-busy", "true");
    nf.input.readOnly = true;
    try {
      const data = await apiFetch("/api/fs/mkdir", { method: "POST", body: { dir, name } });
      if (fsNewFolder !== nf) return;
      fsNewFolder = null;
      nf.row.remove();
      fsCreatedPath = data && data.path || "";
      if (state.fsListToken !== token) return;
      await loadDir(dir, false);
      if (fromBlur && nextFocus && nextFocus.isConnected) nextFocus.focus();
    } catch (e) {
      if (fsNewFolder !== nf) return;
      nf.busy = false;
      nf.input.readOnly = false;
      nf.row.removeAttribute("aria-busy");
      nf.row.classList.add("fs-edit-row-error");
      nf.error.textContent = fsMkdirError(e);
      nf.input.setAttribute("aria-invalid", "true");
      nf.input.focus();
      nf.input.select();
    }
  }
  function openFsBrowser(mode) {
    fsMode = mode;
    fsPath = "";
    fsParent = null;
    fsEntries = [];
    fsCreatedPath = "";
    fsFirstLoad = true;
    cancelNewFolder();
    if (mode === "new") {
      $("#fs-title").textContent = "New project";
      $("#fs-create").textContent = "Create";
      $("#fs-create").classList.remove("hidden");
    } else {
      $("#fs-title").textContent = "Open project";
      $("#fs-create").classList.add("hidden");
    }
    syncFilenameBar();
    $("#fs-filename-input").value = "";
    syncCreateAction();
    hidePickerBody();
    setFsListing(true);
    $("#fs-up").disabled = true;
    $("#fs-mkdir-btn").disabled = true;
    $("#fs-path-input").disabled = false;
    fsModal.classList.remove("hidden", "closing");
    const settled = busy ? Promise.resolve(null) : reconciledBackendUrl().catch((e) => {
      notice("could not reach the backend: " + (e && e.message ? e.message : e));
      return null;
    });
    settled.then((url) => {
      if (url) switchBackend(url);
      renderConnSelector();
      loadDir(localStorage.getItem("clutch_fs_last_dir") || "");
    });
  }
  function closeFsBrowser() {
    setFsListing(false);
    cancelNewFolder();
    closeModal(fsModal);
  }
  var fsRowActions = /* @__PURE__ */ new WeakMap();
  var TAP_SLOP_PX = 10;
  var fsPress = null;
  var fsActivatedRow = null;
  function fsTappableRowAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const row = el && el.closest ? el.closest(".fs-row") : null;
    return row && fsRowActions.has(row) ? row : null;
  }
  function fsRow(label, cls = "", onClick = null) {
    const row = document.createElement("div");
    row.className = "fs-row " + cls;
    const name = document.createElement("span");
    name.className = "fs-name";
    name.textContent = label;
    name.title = label;
    row.appendChild(name);
    if (onClick) {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      fsRowActions.set(row, onClick);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      });
      row.addEventListener("click", () => {
        if (fsActivatedRow === row) {
          fsActivatedRow = null;
          return;
        }
        onClick();
      });
    }
    return row;
  }
  $("#fs-list").addEventListener("pointerdown", (e) => {
    fsPress = fsTappableRowAt(e.clientX, e.clientY) ? { x: e.clientX, y: e.clientY } : null;
  });
  $("#fs-list").addEventListener("pointerup", (e) => {
    const press = fsPress;
    fsPress = null;
    if (!press) return;
    if (Math.abs(e.clientX - press.x) > TAP_SLOP_PX || Math.abs(e.clientY - press.y) > TAP_SLOP_PX) return;
    const row = fsTappableRowAt(e.clientX, e.clientY);
    if (!row) return;
    fsActivatedRow = row;
    fsRowActions.get(row)();
  });
  $("#fs-list").addEventListener("pointercancel", () => {
    fsPress = null;
  });
  $("#fs-list").addEventListener("keydown", (e) => {
    const target = e.target;
    if (target && target.tagName === "INPUT") return;
    if (!fsRows.length) return;
    const at = fsRows.indexOf(target);
    let next = -1;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : Math.min(at + 1, fsRows.length - 1);
    else if (e.key === "ArrowUp") next = at <= 0 ? 0 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = fsRows.length - 1;
    else if (e.key === "Backspace" && fsParent) {
      e.preventDefault();
      loadDir(fsParent);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    fsRows[next].focus();
  });
  async function loadDir(path, remember = true, refetched = false) {
    const listEl = $("#fs-list");
    const token = ++state.fsListToken;
    pendingCreate = "";
    lastStatInput = "";
    if (!state.apiBase) {
      listEl.innerHTML = "";
      hidePickerBody();
      if (!refetched) {
        const before = state.apiBase;
        try {
          await switchBackendResolved();
        } catch (e) {
        }
        if (token === state.fsListToken && state.apiBase && state.apiBase !== before) {
          return loadDir(path, remember, true);
        }
      }
      return;
    }
    listEl.innerHTML = '<div class="fs-row plain">loading\u2026</div>';
    setFsListing(true);
    try {
      const data = await apiFetch(
        "/api/fs/list?path=" + encodeURIComponent(path) + (showHidden ? "&hidden=1" : "")
      );
      if (token !== state.fsListToken) return;
      fsPath = data.path;
      fsParent = data.parent;
      if (remember) localStorage.setItem("clutch_fs_last_dir", fsPath);
      const pathInput = $("#fs-path-input");
      pathInput.value = data.path;
      pathInput.title = data.path;
      pathInput.scrollLeft = pathInput.scrollWidth;
      fsNewFolder = null;
      $("#fs-up").disabled = !data.parent;
      $("#fs-mkdir-btn").disabled = false;
      showPickerBody();
      listEl.innerHTML = "";
      fsEntries = (data.entries || []).map((e) => e.name);
      fsRows = [];
      let created = null;
      const entries = data.entries || [];
      for (const e of entries) {
        const label = e.link ? e.name + " \u2192 " + e.link : e.name;
        let row;
        if (e.dir) {
          const fresh = e.path === fsCreatedPath;
          row = fsRow(label, fresh ? "dir just-created" : "dir", () => loadDir(e.path));
          if (fresh) created = row;
        } else if (e.name.endsWith(".clc") && fsMode === "open") {
          row = fsRow(label, "file clc", () => {
            closeFsBrowser();
            openProject(e.path);
          });
        } else {
          row = fsRow(label, "file plain");
        }
        listEl.appendChild(row);
        if (row.tabIndex === 0) fsRows.push(row);
      }
      fsCreatedPath = "";
      if (!entries.length) {
        const empty = document.createElement("div");
        empty.className = "fs-empty";
        const glyph = document.createElement("span");
        glyph.className = "fs-empty-glyph";
        glyph.setAttribute("aria-hidden", "true");
        glyph.textContent = "\u25A4";
        const line = document.createElement("p");
        line.textContent = "this folder is empty";
        const hint = document.createElement("p");
        hint.className = "fs-empty-hint";
        hint.textContent = fsMode === "new" ? "\uFF0B New folder makes one here" : "nothing to open in it";
        empty.appendChild(glyph);
        empty.appendChild(line);
        empty.appendChild(hint);
        listEl.appendChild(empty);
      }
      if (created) created.focus();
      else if (!IS_ANDROID) {
        if (fsFirstLoad && fsMode === "new") $("#fs-filename-input").focus();
        else if (fsRows.length) fsRows[0].focus();
      }
      fsFirstLoad = false;
    } catch (e) {
      if (token !== state.fsListToken) return;
      const remembered = localStorage.getItem("clutch_fs_last_dir");
      if (remembered && path === remembered) {
        localStorage.removeItem("clutch_fs_last_dir");
        loadDir("");
        return;
      }
      if (!e.status && !refetched && state.apiBase) {
        const before = state.apiBase;
        let moved = false;
        try {
          moved = await switchBackendResolved();
        } catch (err) {
          moved = false;
        }
        if (token === state.fsListToken && moved && state.apiBase && state.apiBase !== before) {
          return loadDir(path, remember, true);
        }
      }
      listEl.innerHTML = "";
      hidePickerBody();
      connStatus.textContent = "Cannot reach backend at " + state.apiBase + " (" + (e.message || e) + "). Connect again below.";
    } finally {
      if (token === state.fsListToken) setFsListing(false);
    }
  }
  $("#fs-cancel").addEventListener("click", closeFsBrowser);
  $("#fs-up").addEventListener("click", () => {
    if (fsParent) loadDir(fsParent);
  });
  var pendingCreate = "";
  var lastStatInput = "";
  function clearCreateOffer() {
    const offer = $("#fs-list").querySelector(".create-offer");
    if (offer) offer.remove();
  }
  function showCreateOffer(dir, name) {
    clearCreateOffer();
    const label = "\uFF0B New: " + name;
    const row = fsRow(label, "create-offer", () => confirmCreate(dir, name));
    $("#fs-list").insertBefore(row, $("#fs-list").firstChild);
  }
  function confirmCreate(dir, name) {
    pendingCreate = "";
    lastStatInput = "";
    closeFsBrowser();
    createProject(dir, name);
  }
  async function resolvePathInput() {
    const value = $("#fs-filename-input").value.trim();
    if (!value) return;
    if (pendingCreate && value === lastStatInput) {
      const [dir, name] = pendingCreate.split("\0");
      confirmCreate(dir, name);
      return;
    }
    lastStatInput = value;
    pendingCreate = "";
    clearCreateOffer();
    const input = value.startsWith("/") || value.startsWith("~") ? value : fsPath ? fsPath.replace(/\/$/, "") + "/" + value : value;
    try {
      const data = await apiFetch("/api/fs/stat?path=" + encodeURIComponent(input));
      if (data && data.error) {
        notice(data.error);
        return;
      }
      if (data.type === "dir") {
        loadDir(data.path);
      } else if (data.type === "file") {
        if (data.path.endsWith(".clc") && (fsMode === "open" || fsMode === "new")) {
          closeFsBrowser();
          openProject(data.path);
        } else {
          const slash = data.path.lastIndexOf("/");
          const parent = slash >= 0 ? data.path.slice(0, slash) || "/" : fsPath;
          if (parent) loadDir(parent);
        }
      } else {
        const slash = data.path.lastIndexOf("/");
        const dir = slash >= 0 ? data.path.slice(0, slash) || "/" : fsPath;
        const name = slash >= 0 ? data.path.slice(slash + 1) : data.path;
        if (!dir || !name) return;
        if (fsMode === "new") {
          confirmCreate(dir, name);
          return;
        }
        pendingCreate = dir + "\0" + name;
        showCreateOffer(dir, name);
      }
    } catch (e) {
      notice("Could not check path: " + (e && e.message ? e.message : e));
    }
  }
  $("#fs-filename-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") resolvePathInput();
  });
  $("#fs-filename-input").addEventListener("input", () => {
    pendingCreate = "";
    lastStatInput = "";
    clearCreateOffer();
    syncCreateAction();
  });
  $("#fs-create").addEventListener("click", () => {
    const name = $("#fs-filename-input").value.trim();
    if (!name || !fsPath) return;
    closeFsBrowser();
    createProject(fsPath, name);
  });
  $("#fs-cancel").addEventListener("pointerdown", cancelNewFolder);
  $("#fs-create").addEventListener("pointerdown", cancelNewFolder);
  fsModal.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target === fsModal) cancelNewFolder();
    },
    true
  );
  $("#fs-mkdir-btn").addEventListener("click", beginNewFolder);
  dismissOnOverlayPress(fsModal, closeFsBrowser);
  $("#welcome-new").addEventListener("click", () => openFsBrowser("new"));
  $("#welcome-open").addEventListener("click", () => openFsBrowser("open"));

  // src/renderer/workspace-panel.ts
  var lastTreeSig = "";
  var treeRefreshTimer = null;
  var showHidden = localStorage.getItem("clutch_show_hidden") === "1";
  function updateHiddenToggles() {
    $("#fs-hidden-toggle").checked = showHidden;
    $("#tree-hidden-toggle").checked = showHidden;
  }
  function toggleHidden() {
    showHidden = !showHidden;
    localStorage.setItem("clutch_show_hidden", showHidden ? "1" : "0");
    updateHiddenToggles();
    if (!fsModal.classList.contains("hidden")) loadDir(fsPath);
    refreshTree();
  }
  $("#fs-hidden-toggle").addEventListener("change", toggleHidden);
  $("#tree-hidden-toggle").addEventListener("change", toggleHidden);
  updateHiddenToggles();
  var shellBackdrop = $("#shell-backdrop");
  var shellPanel = $("#right");
  var NARROW_Q = window.matchMedia("(max-width: 640px)");
  function paintShellPanel(open) {
    shellPanel.classList.toggle("drawer-open", open);
    shellBackdrop.classList.toggle("open", open);
  }
  var panelHistoryEntry = false;
  var consumingEntry = false;
  function setShellPanel(open) {
    const was = shellPanel.classList.contains("drawer-open");
    paintShellPanel(open);
    if (open === was) return;
    if (open) {
      try {
        history.pushState({ clutchShellPanel: 1 }, "");
        panelHistoryEntry = true;
      } catch (e) {
        panelHistoryEntry = false;
      }
    } else if (panelHistoryEntry) {
      panelHistoryEntry = false;
      consumingEntry = true;
      try {
        history.back();
      } catch (e) {
        consumingEntry = false;
      }
    }
  }
  function closeShellPanel() {
    setShellPanel(false);
  }
  window.addEventListener("popstate", () => {
    if (consumingEntry) {
      consumingEntry = false;
      return;
    }
    if (!panelHistoryEntry) return;
    panelHistoryEntry = false;
    paintShellPanel(false);
  });
  $("#shell-ws-btn").addEventListener(
    "click",
    () => setShellPanel(!shellPanel.classList.contains("drawer-open"))
  );
  $("#shell-close-btn").addEventListener("click", () => {
    if (NARROW_Q.matches) closeShellPanel();
    else shellPanel.classList.add("panel-hidden");
  });
  shellBackdrop.addEventListener("click", closeShellPanel);
  function layoutShell() {
    if (!NARROW_Q.matches) closeShellPanel();
  }
  NARROW_Q.addEventListener("change", layoutShell);
  layoutShell();
  function scheduleTreeRefresh(delay = 300) {
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = setTimeout(() => {
      for (const one of treeStates.values()) one.fetchedAt = 0;
      void refreshTree(true);
    }, delay);
  }
  var treeStates = /* @__PURE__ */ new Map();
  var NO_TREE = { root: "", tree: [], expanded: /* @__PURE__ */ new Set(), sig: "", fetchedAt: 0 };
  var shownWorkspace = null;
  var treeGen = 0;
  var treeWalk = null;
  var TREE_FRESH_MS = 1e4;
  function treeState(project) {
    let st = treeStates.get(project);
    if (!st) {
      st = { root: "", tree: [], expanded: /* @__PURE__ */ new Set(), sig: "", fetchedAt: 0 };
      treeStates.set(project, st);
    }
    return st;
  }
  function paintTree(tree, expanded, sig) {
    lastTreeSig = sig;
    els.tree.innerHTML = "";
    for (const node of tree) els.tree.appendChild(renderNode(node, 0, expanded));
  }
  function enterWorkspace(project, root = "") {
    const next = project || "";
    if (shownWorkspace === next) {
      if (root) els.workspace.textContent = root;
      return;
    }
    shownWorkspace = next;
    treeGen++;
    clearTimeout(treeRefreshTimer);
    treeRefreshTimer = null;
    dropWalk();
    const st = treeStates.get(next) || NO_TREE;
    const where = root || st.root;
    els.workspace.textContent = where || "";
    paintTree(st.tree, st.expanded, st.sig);
  }
  function dropWalk() {
    if (!treeWalk) return;
    try {
      treeWalk.ctl.abort();
    } catch (e) {
    }
    treeWalk = null;
  }
  async function refreshTree(force = false) {
    const project = shownWorkspace || "";
    if (treeWalk && treeWalk.project === project) return;
    const st = treeState(project);
    if (!force && st.fetchedAt && Date.now() - st.fetchedAt < TREE_FRESH_MS) return;
    dropWalk();
    const gen = ++treeGen;
    const ctl = new AbortController();
    treeWalk = { project, ctl };
    try {
      const params = new URLSearchParams();
      if (showHidden) params.set("hidden", "1");
      for (const p of st.expanded) params.append("expanded", p);
      const qs = params.toString() ? "?" + params : "";
      const data = await apiFetch("/api/workspace/tree" + qs, { signal: ctl.signal });
      if (gen !== treeGen) return;
      if (data.root) {
        st.root = data.root;
        els.workspace.textContent = data.root;
      }
      const tree = data.tree || [];
      const sig = JSON.stringify([...st.expanded]) + "|" + JSON.stringify(tree);
      st.tree = tree;
      st.sig = sig;
      st.fetchedAt = Date.now();
      if (sig !== lastTreeSig) paintTree(tree, st.expanded, sig);
    } catch (e) {
      if (!(e && e.name === "AbortError")) console.warn("[tree] refresh failed", e);
    } finally {
      if (treeWalk && treeWalk.ctl === ctl) treeWalk = null;
    }
  }
  function pendingRow(depth) {
    const row = document.createElement("div");
    row.className = "tree-node file tree-pending";
    row.style.paddingLeft = depth * 12 + "px";
    row.style.opacity = "0.55";
    row.style.fontStyle = "italic";
    row.innerHTML = `<span class="icon">\xB7</span><span class="name">loading\u2026</span>`;
    return row;
  }
  function renderNode(node, depth, expanded) {
    const wrap = document.createElement("div");
    wrap.className = "tree-branch";
    const row = document.createElement("div");
    row.className = "tree-node " + (node.dir ? "dir" : "file");
    row.style.paddingLeft = depth * 12 + "px";
    const label = node.link ? `${node.name} \u2192 ${node.link}` : node.name;
    row.innerHTML = `<span class="icon">${node.dir ? "\u25B8" : "\xB7"}</span><span class="name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
    wrap.appendChild(row);
    if (node.dir) {
      const isOpen = expanded.has(node.path);
      const children = document.createElement("div");
      children.className = "tree-children";
      children.style.display = isOpen ? "" : "none";
      if (isOpen) row.querySelector(".icon").textContent = "\u25BE";
      if (isOpen) {
        if (node.children) {
          for (const c of node.children) children.appendChild(renderNode(c, depth + 1, expanded));
        } else {
          children.appendChild(pendingRow(depth + 1));
        }
      }
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = children.style.display !== "none";
        if (open) {
          expanded.delete(node.path);
          children.style.display = "none";
          row.querySelector(".icon").textContent = "\u25B8";
          return;
        }
        expanded.add(node.path);
        row.querySelector(".icon").textContent = "\u25BE";
        children.innerHTML = "";
        if (node.children && node.children.length) {
          for (const c of node.children) children.appendChild(renderNode(c, depth + 1, expanded));
        } else {
          children.appendChild(pendingRow(depth + 1));
        }
        children.style.display = "";
        scheduleTreeRefresh(0);
      });
      wrap.appendChild(children);
    }
    return wrap;
  }

  // src/renderer/tool-render.ts
  function uiDefaults() {
    return state.hostUiDefaults ? Object.assign({}, UI_DEFAULTS, state.hostUiDefaults) : UI_DEFAULTS;
  }
  var UI_DEFAULTS = {
    group: null,
    chip: "name",
    summary: "",
    preview: "args",
    header: "",
    form: "block",
    body: "text",
    collapse: "never",
    highlight: "",
    chrome: "",
    mutates: true,
    undo: false
  };
  var CALL_BLOCK = "__calls__";
  var RESULT_FOLD_LINES = 60;
  function uiOf(ev) {
    return Object.assign({}, uiDefaults(), ev && ev.ui || {});
  }
  function uiOfResult(ev) {
    const call = toolCalls[ev.tool_call_id];
    if (call && call.ui) return Object.assign({}, uiDefaults(), call.ui);
    return uiOf(ev);
  }
  function templateText(tpl, name, args, content) {
    const lines = content === null || content === void 0 ? "\u2026" : String(content).split("\n").length;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args || "{}");
      } catch (e) {
        args = {};
      }
    }
    return String(tpl || "").replace(/\{([A-Za-z_]+)\}/g, (match, key) => {
      if (key === "name") return name;
      if (key === "lines") return String(lines);
      const v = args ? args[key] : void 0;
      if (v === void 0 || v === null) return "";
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  function partialArg(raw, key) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object" && p[key] !== void 0) {
        return typeof p[key] === "string" ? p[key] : JSON.stringify(p[key]);
      }
    } catch (e) {
    }
    const m = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(raw || "");
    if (!m) return null;
    return m[1].replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  function previewText(ui, name, raw) {
    const spec = ui.preview && typeof ui.preview === "object" ? ui.preview : { mode: ui.preview };
    const mode = spec.mode || "args";
    if (mode === "none") return "";
    if (mode === "command") {
      const cmd = extractCommand(raw);
      return cmd !== null ? (spec.mark || "$ ") + cmd : raw || "";
    }
    if (mode === "content" && spec.keys && spec.keys.length) {
      const parts = [];
      for (const key of spec.keys) {
        const mark = /^[-+✎]/.test(key) ? key[0] + " " : "";
        const value = partialArg(raw, mark ? key.slice(1) : key);
        if (value !== null) parts.push(mark + value);
      }
      if (parts.length) return parts.join("\n");
    }
    if (mode === "content") {
      return String(raw || "").replace(/^\{/, "").replace(/\}$/, "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    return raw || "";
  }
  function ensureToolGroup(key) {
    if (!state.toolGroupEl || state.toolGroupEl.closed || state.toolGroupEl.key !== key) {
      state.toolGroupEl = {
        el: document.createElement("div"),
        ids: /* @__PURE__ */ new Set(),
        key,
        closed: false
      };
      state.toolGroupEl.el.className = "event tool_group";
      state.toolGroupEl.el.innerHTML = '<div class="hdr">tools</div>';
      (pageSink || eventsEl).appendChild(state.toolGroupEl.el);
    }
    return state.toolGroupEl;
  }
  function toolGroupFor(id, ui) {
    const group = ensureToolGroup(ui.group || CALL_BLOCK);
    group.ids.add(id);
    toolCallGroups.set(id, group);
    return group;
  }
  function makeToolRowBase(ui, name) {
    const row = document.createElement("div");
    row.className = "tool-row";
    if (ui.chip !== "none") {
      const chip = document.createElement("span");
      chip.className = "tool-name";
      chip.textContent = name;
      row.appendChild(chip);
    }
    return row;
  }
  function argsButton(raw, ui) {
    const btn = document.createElement("span");
    btn.className = "tool-args-btn";
    btn.textContent = "args \u25B8";
    btn.onclick = () => {
      const row = btn.parentElement;
      const existing = row.querySelector(".fold.args-fold");
      if (existing) {
        foldCollapse(existing, () => existing.remove());
        btn.textContent = "args \u25B8";
      } else {
        btn.textContent = "args \u25BE";
        const pre = document.createElement("pre");
        pre.className = "tool-args-detail";
        pre.textContent = argsDetail(ui, raw);
        const fold = wrapFold(pre);
        fold.classList.add("args-fold");
        row.appendChild(fold);
        foldExpand(fold);
      }
    };
    return btn;
  }
  function argsDetail(ui, raw) {
    const spec = ui.preview && typeof ui.preview === "object" ? ui.preview : { mode: ui.preview };
    if (spec.mode === "command") {
      const cmd = extractCommand(raw);
      if (cmd !== null) return (spec.mark || "$ ") + cmd;
    }
    try {
      return JSON.stringify(JSON.parse(raw || "{}"), null, 1);
    } catch (e) {
      return raw || "";
    }
  }
  function extractCommand(txt) {
    let s = txt;
    for (let depth = 0; depth < 3; depth++) {
      let parsed;
      try {
        parsed = JSON.parse(s);
      } catch (e) {
        return typeof s === "string" && s !== txt ? s : null;
      }
      if (typeof parsed === "string") {
        s = parsed;
        continue;
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (typeof parsed.command === "string") {
          s = parsed.command;
          continue;
        }
        if (parsed.command && typeof parsed.command === "object" && !Array.isArray(parsed.command)) {
          s = JSON.stringify(parsed.command);
          continue;
        }
        return null;
      }
      return null;
    }
    return typeof s === "string" ? s : null;
  }
  function permReason(reason) {
    return String(reason || "").replace(/\s+with args\b[\s\S]*$/, "");
  }
  function makeToolRow(ev) {
    const row = makeToolRowBase(uiOf(ev), ev.name);
    row.appendChild(argsButton(ev.arguments, uiOf(ev)));
    return row;
  }
  function addToolCallRow(ev) {
    const group = toolGroupFor(ev.tool_call_id, uiOf(ev));
    group.el.appendChild(makeToolRow(ev));
    autoScroll();
  }
  function buildResultRow(ui, call, result) {
    const summary = templateText(ui.summary, call.name, call.args || {}, result.content);
    const row = document.createElement("div");
    row.className = "result-row";
    const body = buildResultBody(ui, result, call.args || {});
    const full = body ? wrapFold(body) : null;
    if (full) {
      const toggle = document.createElement("span");
      toggle.className = "fold-toggle";
      toggle.textContent = "\u25B8";
      row.appendChild(toggle);
      row.onclick = () => {
        const wasHidden = toggleFold(full);
        toggle.textContent = wasHidden ? "\u25BE" : "\u25B8";
      };
    }
    const lbl = document.createElement("span");
    lbl.className = "result-label";
    lbl.textContent = summary;
    row.appendChild(lbl);
    return { row, full };
  }
  function appendResultRow(group, ui, call, ev) {
    const { row, full } = buildResultRow(ui, call, ev);
    group.el.appendChild(row);
    if (full) group.el.appendChild(full);
    autoScroll();
  }
  function buildResultRowBlock(ui, call, ev) {
    const wrap = document.createElement("div");
    wrap.className = "event tool_result" + (ev.is_error ? " error" : "") + " form-row";
    const hdr = document.createElement("div");
    hdr.className = "hdr";
    hdr.textContent = ev.is_error ? "result \u26A0" : "result";
    wrap.appendChild(hdr);
    const { row, full } = buildResultRow(ui, call, ev);
    wrap.appendChild(row);
    if (full) wrap.appendChild(full);
    return wrap;
  }
  function buildResultBlock(ui, name, args, result) {
    const wrap = document.createElement("div");
    wrap.className = "event tool_result" + (result.is_error ? " error" : "") + (ui.chrome ? " " + ui.chrome : "");
    const tpl = ui.header || ui.summary;
    const hdr = result.is_error ? "result \u26A0" : tpl ? templateText(tpl, name, args, result.content) : "result";
    const head = document.createElement("div");
    head.className = "hdr";
    head.textContent = hdr;
    wrap.appendChild(head);
    const body = buildResultBody(ui, result, args);
    if (body) {
      if (ui.body === "diff" && result.diff) {
        const note = document.createElement("div");
        note.className = "body md-plain";
        note.textContent = result.content;
        if ((result.content || "").trim()) wrap.appendChild(note);
        wrap.appendChild(body);
      } else if (foldAtRest(ui, result)) {
        const fold = wrapFold(body);
        const toggle = document.createElement("span");
        toggle.className = "fold-toggle";
        toggle.textContent = "\u25B8";
        toggle.onclick = () => {
          toggle.textContent = toggleFold(fold) ? "\u25BE" : "\u25B8";
        };
        wrap.appendChild(toggle);
        wrap.appendChild(fold);
      } else {
        wrap.appendChild(body);
      }
    }
    if (ui.body === "diff" && body && (result.diff || "").split("\n").length > RESULT_FOLD_LINES) {
      body.classList.add("diff-collapsed");
      const expand = document.createElement("button");
      expand.className = "diff-expand";
      const setLabel = () => {
        expand.textContent = body.classList.contains("diff-collapsed") ? "Show full diff" : "Hide diff";
      };
      setLabel();
      expand.onclick = () => {
        if (body.classList.contains("diff-collapsed")) expandDiff(body);
        else collapseDiff(body);
        setLabel();
      };
      wrap.appendChild(expand);
    }
    if (ui.undo && !result.is_error) {
      const undoBtn = document.createElement("button");
      undoBtn.className = "diff-expand undo-btn";
      undoBtn.textContent = "\u21B6 undo";
      undoBtn.onclick = async () => {
        try {
          const data = await apiFetch("/api/workspace/revert", {
            method: "POST",
            body: { path: args && args.path || "" }
          });
          if (data && data.status === "ok") {
            undoBtn.textContent = "\u21B6 undone";
            undoBtn.disabled = true;
            refreshTree();
          } else {
            undoBtn.textContent = "\u21B6 no snapshot";
            undoBtn.disabled = true;
          }
        } catch (e) {
          undoBtn.textContent = e.status ? "\u21B6 no snapshot" : "\u21B6 failed";
          undoBtn.disabled = true;
        }
      };
      wrap.appendChild(undoBtn);
    }
    return wrap;
  }
  function buildResultBody(ui, result, args) {
    if (ui.body === "none") return null;
    if (ui.body === "diff") {
      if (!result.diff) return (result.content || "").trim() ? plainBody(result.content) : null;
      return renderDiff(result.diff);
    }
    if (ui.body === "code") {
      const pre = document.createElement("pre");
      pre.className = "result-detail";
      pre.textContent = result.content || "";
      if (ui.highlight === "path") highlightPreByPath(pre, args && args.path || "");
      return pre;
    }
    return plainBody(result.content);
  }
  function plainBody(text) {
    const plain = document.createElement("div");
    plain.className = "body md-plain";
    plain.textContent = text || "";
    return plain;
  }
  function foldAtRest(ui, result) {
    if (ui.collapse === "always") return true;
    if (ui.collapse !== "long") return false;
    const text = ui.body === "diff" ? result.diff || result.content || "" : result.content || "";
    return String(text).split("\n").length > RESULT_FOLD_LINES;
  }

  // src/renderer/permissions.ts
  var permModal = $("#perm-modal");
  var pendingPerm = null;
  var answeredPerm = /* @__PURE__ */ new Set();
  function forgetAnsweredPerm() {
    if (answeredPerm.size) answeredPerm.clear();
  }
  function openPerm(ev) {
    if (answeredPerm.has(ev.request_id)) return;
    if (pendingPerm && pendingPerm.request_id === ev.request_id) return;
    pendingPerm = ev;
    const reason = permReason(ev.reason);
    $("#perm-tool").textContent = `Tool: ${ev.tool} \u2014 ${reason}`;
    const argsEl = $("#perm-args");
    let txt = ev.args_repr || "";
    let isJson = false;
    const cmd = extractCommand(txt);
    if (cmd !== null) txt = "$ " + cmd;
    else {
      try {
        txt = JSON.stringify(JSON.parse(txt), null, 2);
        isJson = true;
      } catch (e) {
      }
    }
    argsEl.textContent = "";
    if (typeof hljs !== "undefined" && isJson) {
      const code = document.createElement("code");
      code.className = "language-json";
      code.textContent = txt;
      argsEl.appendChild(code);
      try {
        hljs.highlightElement(code);
      } catch (e) {
      }
    } else {
      argsEl.textContent = txt;
    }
    permModal.classList.remove("hidden", "closing");
    setStatus("waiting");
    if (trustArmed()) startTrustCountdown();
  }
  function closePerm() {
    stopTrustCountdown();
    closeModal(permModal);
    pendingPerm = null;
  }
  async function respondPerm(allow) {
    if (!pendingPerm) return;
    const ev = pendingPerm;
    closePerm();
    answeredPerm.add(ev.request_id);
    setStatus("running");
    try {
      await apiFetch("/api/permission/respond", {
        method: "POST",
        body: { request_id: ev.request_id, allow }
      });
    } catch (e) {
      console.error("[permission] verdict not delivered", e);
      if (e && e.status) return;
      answeredPerm.delete(ev.request_id);
      openPerm(ev);
    }
  }
  $("#perm-allow").addEventListener("click", () => respondPerm(true));
  $("#perm-deny").addEventListener("click", () => respondPerm(false));
  function permKey(e) {
    if (e.key !== "Enter" || e.isComposing || !pendingPerm) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    e.preventDefault();
    respondPerm(true);
    return true;
  }
  document.addEventListener("keydown", permKey);
  var TRUST_COUNTDOWN_S = 10;
  var trustTimer = null;
  var trustDeadline = 0;
  function trustArmed() {
    return localStorage.getItem("clutch_trust_all") === "1";
  }
  async function pushTrustArmed() {
    const bases = /* @__PURE__ */ new Set();
    if (state.apiBase) bases.add(state.apiBase);
    for (const t of state.tabs) if (t.base) bases.add(t.base);
    if (!bases.size) return;
    await Promise.all(
      [...bases].map(
        (base) => apiFetch("/api/permission/trust", { method: "POST", body: { armed: trustArmed() }, base }).catch(
          (e) => console.warn("[trust] could not mirror the armed flag to the backend", e)
        )
      )
    );
  }
  function paintTrustBtn() {
    els.trust.textContent = trustArmed() ? "\u{1F6E1} Trusted" : "\u{1F6E1} Trust";
  }
  function setTrustArmed(on) {
    localStorage.setItem("clutch_trust_all", on ? "1" : "0");
    els.trust.classList.toggle("trust-on", on);
    els.trust.title = on ? `trust mode ON \u2014 prompts auto-allow after ${TRUST_COUNTDOWN_S}s unless denied. Click to disable.` : `trust mode OFF \u2014 every prompt waits. Click to auto-allow after ${TRUST_COUNTDOWN_S}s.`;
    paintTrustBtn();
    pushTrustArmed();
    if (!on) stopTrustCountdown();
    else if (pendingPerm) startTrustCountdown();
  }
  function trustTick() {
    trustTimer = null;
    if (!pendingPerm) return;
    const left = Math.ceil((trustDeadline - Date.now()) / 1e3);
    if (left <= 0) {
      respondPerm(true);
      return;
    }
    $("#perm-allow").textContent = `Allow (${left}s)`;
    trustTimer = setTimeout(trustTick, 1e3);
  }
  function trustResumeTick() {
    if (typeof document !== "undefined" && document.hidden) return;
    if (!pendingPerm || !trustArmed()) return;
    if (trustTimer) {
      clearTimeout(trustTimer);
      trustTimer = null;
    }
    trustTick();
  }
  function startTrustCountdown() {
    stopTrustCountdown();
    if (!trustArmed() || !pendingPerm) return;
    trustDeadline = Date.now() + TRUST_COUNTDOWN_S * 1e3;
    trustTick();
  }
  function stopTrustCountdown() {
    if (trustTimer) {
      clearTimeout(trustTimer);
      trustTimer = null;
    }
    trustDeadline = 0;
    $("#perm-allow").textContent = "Allow";
  }
  document.addEventListener("visibilitychange", trustResumeTick);
  window.addEventListener("pageshow", trustResumeTick);
  window.addEventListener("focus", trustResumeTick);
  els.trust.addEventListener("click", () => setTrustArmed(!trustArmed()));
  setTrustArmed(trustArmed());

  // src/renderer/task-input.ts
  var TASK_UNDO_MAX = 200;
  var TASK_UNDO_BURST_MS = 500;
  var taskUndoStack = [];
  var taskRedoStack = [];
  var taskUndoAt = 0;
  var taskLastValue = els.task.value;
  function taskPushUndo(value, forced) {
    const now = performance.now();
    if (!forced && now - taskUndoAt < TASK_UNDO_BURST_MS && taskUndoStack.length) return;
    taskUndoAt = now;
    if (taskUndoStack[taskUndoStack.length - 1] === value) return;
    taskUndoStack.push(value);
    if (taskUndoStack.length > TASK_UNDO_MAX) taskUndoStack.shift();
    taskRedoStack = [];
  }
  function taskSetValue(value) {
    els.task.value = value;
    taskLastValue = value;
    els.task.dispatchEvent(new Event("input"));
  }
  function taskUndo() {
    if (!taskUndoStack.length) return false;
    taskRedoStack.push(els.task.value);
    taskSetValue(taskUndoStack.pop());
    return true;
  }
  function taskRedo() {
    if (!taskRedoStack.length) return false;
    taskUndoStack.push(els.task.value);
    taskSetValue(taskRedoStack.pop());
    return true;
  }
  var TASK_HISTORY_MAX = 200;
  var taskHistory = [];
  var taskHistoryPos = -1;
  var taskDraft = "";
  function recordSentTask(task) {
    const text = String(task == null ? "" : task);
    if (text.trim() && taskHistory[taskHistory.length - 1] !== text) taskHistory.push(text);
    if (taskHistory.length > TASK_HISTORY_MAX) taskHistory.shift();
    taskHistoryPos = -1;
    taskDraft = "";
    taskLastValue = els.task.value;
  }
  function taskHistoryOlder() {
    if (!taskHistory.length) return false;
    if (taskHistoryPos < 0) {
      taskDraft = els.task.value;
      taskHistoryPos = taskHistory.length - 1;
    } else if (taskHistoryPos > 0) {
      taskHistoryPos--;
    } else {
      return false;
    }
    taskSetValue(taskHistory[taskHistoryPos]);
    taskCaretToEnd();
    return true;
  }
  function taskHistoryNewer() {
    if (taskHistoryPos < 0) return false;
    if (taskHistoryPos < taskHistory.length - 1) {
      taskHistoryPos++;
      taskSetValue(taskHistory[taskHistoryPos]);
    } else {
      taskHistoryPos = -1;
      taskSetValue(taskDraft);
    }
    taskCaretToEnd();
    return true;
  }
  function taskCaretToEnd() {
    const n = els.task.value.length;
    try {
      els.task.setSelectionRange(n, n);
    } catch (e) {
    }
  }
  function fillTaskInput(text) {
    taskPushUndo(els.task.value, true);
    taskSetValue(String(text == null ? "" : text));
    taskHistoryPos = -1;
    taskDraft = "";
    els.task.focus();
    taskCaretToEnd();
  }
  els.task.addEventListener("input", () => {
    if (els.task.value === taskLastValue) return;
    taskPushUndo(taskLastValue, false);
    taskLastValue = els.task.value;
    taskHistoryPos = -1;
    taskDraft = "";
  });
  function taskCaretOnFirstLine() {
    const s = els.task.selectionStart, e = els.task.selectionEnd;
    if (s !== e) return false;
    return els.task.value.lastIndexOf("\n", s - 1) < 0;
  }
  function taskCaretOnLastLine() {
    const s = els.task.selectionStart, e = els.task.selectionEnd;
    if (s !== e) return false;
    return els.task.value.indexOf("\n", s) < 0;
  }
  els.task.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = (e.key || "").toLowerCase();
    if (mod && e.shiftKey && key === "z") {
      if (taskRedo()) e.preventDefault();
      return;
    }
    if (mod && !e.shiftKey && key === "z") {
      if (taskUndo()) e.preventDefault();
      return;
    }
    if (mod && !e.shiftKey && key === "y") {
      if (taskRedo()) e.preventDefault();
      return;
    }
    if (key === "escape" && els.task.value) {
      taskPushUndo(els.task.value, true);
      taskSetValue("");
      e.preventDefault();
      return;
    }
    if (mod || e.shiftKey || e.altKey) return;
    if (e.key === "ArrowUp" && taskCaretOnFirstLine()) {
      if (taskHistoryOlder()) e.preventDefault();
    } else if (e.key === "ArrowDown" && taskCaretOnLastLine()) {
      if (taskHistoryNewer()) e.preventDefault();
    }
  });

  // src/renderer/pane.ts
  var HOP_SHARE = 0.4;
  var REPLAY_PHASES = {
    parse: [0, 0.5],
    render: [0.5, 0.9],
    typeset: [0.9, 1]
  };
  function paneWelcome() {
    return { view: "welcome" };
  }
  function paneTab(tabId) {
    return { view: "tab", tabId: tabId || "" };
  }
  function paneLoad(tabId, label, where = "") {
    return { view: "load", tabId: tabId || "", label: label || "", where: where || "", progress: { pct: null, note: "" } };
  }
  function paneBlocked(tabId, text, machine = null) {
    return {
      view: "blocked",
      tabId: tabId || null,
      text: text || "",
      machine: machine || null,
      shown: true
    };
  }
  var pane = paneWelcome();
  var listeners = [];
  function currentPane() {
    return pane;
  }
  function paneShowsTab(tabId) {
    return pane.view === "tab" && !!tabId && pane.tabId === tabId;
  }
  function paneBlockedTabId() {
    return pane.view === "blocked" ? pane.tabId : null;
  }
  function paneLoadPct() {
    return pane.view === "load" && pane.progress ? pane.progress.pct : null;
  }
  function onPaneChange(fn) {
    listeners.push(fn);
  }
  function setPane(next) {
    pane = next;
    render();
    for (const fn of listeners) fn(pane);
  }
  function byId(id) {
    return document.getElementById(id);
  }
  function render() {
    const state2 = pane;
    const stream2 = byId("stream");
    if (stream2) {
      stream2.dataset.pane = state2.view;
      stream2.dataset.tabId = state2.view === "tab" || state2.view === "load" ? state2.tabId : "";
      stream2.classList.toggle("loading", state2.view === "load");
    }
    const visible = state2.view === "blocked" && !state2.shown ? "" : state2.view;
    for (const el of Array.from(document.querySelectorAll("[data-view]"))) {
      el.classList.toggle("hidden", el.getAttribute("data-view") !== visible);
    }
    if (state2.view === "load") renderLoad(state2);
    else stopBar();
    if (state2.view === "blocked") renderBlocked(state2);
    if (state2.view !== "tab") {
      const jump = byId("jump-bottom");
      if (jump) jump.classList.add("hidden");
    }
  }
  function renderLoad(state2) {
    const title = byId("tab-load-title");
    if (title) title.textContent = state2.label;
    const where = byId("tab-load-where");
    if (where) where.textContent = state2.where;
    const barEl = byId("open-progress");
    if (!barEl) return;
    const progress = state2.progress;
    barEl.classList.toggle("hidden", !progress);
    if (!progress) {
      stopBar();
      return;
    }
    const note = byId("open-progress-note");
    if (note) note.textContent = progress.note || "";
    const fill = barEl.querySelector(".open-progress-fill");
    const label = barEl.querySelector(".open-progress-label");
    if (!fill) return;
    if (progress.pct === null) {
      stopBar();
      fill.classList.add("indeterminate");
      fill.style.width = "";
      if (label) label.textContent = "";
      return;
    }
    const whole = Math.round(Math.max(0, Math.min(100, progress.pct)));
    fill.classList.remove("indeterminate");
    const fresh = !bar || bar.tabId !== state2.tabId;
    bar = { fill, label, tabId: state2.tabId };
    if (fresh) {
      barShown = 0;
      barPainted = -1;
    }
    barTarget = whole;
    paintBar();
    if (!barStop && barShown !== barTarget) {
      barAt = 0;
      barStop = nextFrame(barFrame);
    }
  }
  var CHASE_TAU_MS = 130;
  var CHASE_MIN_PCT = 0.35;
  function chasePct(shown, target, dtMs) {
    const to = Math.max(0, Math.min(100, Number(target) || 0));
    const from = Math.max(0, Math.min(100, Number(shown) || 0));
    if (!(to > from)) return to;
    const k = 1 - Math.exp(-Math.max(0, Number(dtMs) || 0) / CHASE_TAU_MS);
    return Math.min(to, Math.max(from + (to - from) * k, from + CHASE_MIN_PCT));
  }
  var bar = null;
  var barTarget = 0;
  var barShown = 0;
  var barPainted = -1;
  var barStop = null;
  var barAt = 0;
  function nextFrame(cb) {
    if (typeof requestAnimationFrame === "function") {
      const id2 = requestAnimationFrame(cb);
      return () => cancelAnimationFrame(id2);
    }
    const id = setTimeout(() => cb(Date.now()), 16);
    return () => clearTimeout(id);
  }
  function paintBar() {
    if (!bar) return;
    const whole = Math.round(barShown);
    if (whole === barPainted) return;
    barPainted = whole;
    bar.fill.style.width = whole + "%";
    if (bar.label) bar.label.textContent = whole + "%";
  }
  function barFrame(now) {
    barStop = null;
    if (!bar || pane.view !== "load") {
      bar = null;
      return;
    }
    const dt = barAt ? Math.max(1, now - barAt) : 16;
    barAt = now;
    barShown = chasePct(barShown, barTarget, dt);
    paintBar();
    if (barShown < barTarget) barStop = nextFrame(barFrame);
  }
  function stopBar() {
    if (barStop) barStop();
    barStop = null;
    bar = null;
    barTarget = 0;
    barShown = 0;
    barPainted = -1;
    barAt = 0;
  }
  function renderBlocked(state2) {
    const text = byId("tab-blocked-text");
    if (text) text.textContent = state2.text;
  }
  function setProgress(progress) {
    if (pane.view !== "load") return;
    setPane({ ...pane, progress });
  }
  function reportHopStage(stagePct, note) {
    setProgress({
      pct: stagePct === null ? null : stagePct * HOP_SHARE,
      note: note || ""
    });
  }
  function paneHopSettled(up) {
    if (pane.view !== "load") return;
    setProgress(up ? { pct: paneLoadPct(), note: "Opening project\u2026" } : null);
  }
  function paneReplayProgress(phase, frac) {
    if (pane.view !== "load") return;
    const [from, to] = REPLAY_PHASES[phase];
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    const start = paneLoadPct() ?? 0;
    const end = start + (100 - start) * (from + (to - from) * f);
    setProgress({ pct: end, note: pane.progress ? pane.progress.note : "" });
  }

  // src/renderer/slots.ts
  var SLOT_EVENT = "clutch:tab-state";
  function activeTab() {
    if (!state.activeTabId) return null;
    return state.tabs.find((t) => t.id === state.activeTabId) || null;
  }
  function activeSlotId() {
    return state.activeTabId || "";
  }
  function tabForSlot(slotId) {
    if (!slotId) return null;
    return state.tabs.find((t) => t.id === slotId) || null;
  }
  function findTabByPath(path) {
    return state.tabs.find((t) => t.path === path || t.projectKey === path) || null;
  }
  function ensureTab(path, name = "") {
    const existing = path ? findTabByPath(path) : null;
    if (existing) return existing;
    const tab = {
      id: "tab-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      path,
      name: name || (path ? path.split("/").pop() || path : ""),
      base: null,
      running: false,
      needsInput: false
    };
    state.tabs.push(tab);
    return tab;
  }
  function announceTabState() {
    document.dispatchEvent(new CustomEvent(SLOT_EVENT));
  }
  function machineLabel(m) {
    if (!m) return "this machine";
    return m.user ? `${m.user}@${m.host}:${m.port}` : `${m.host}:${m.port}`;
  }
  function asMachine(v) {
    if (v === void 0) return void 0;
    if (v === null || v === false) return null;
    if (typeof v !== "object" || !v.host) return void 0;
    return {
      host: String(v.host),
      user: String(v.user || ""),
      port: String(v.port === void 0 || v.port === null || v.port === "" ? 22 : v.port)
    };
  }
  function sameMachine(a, b) {
    if (a === void 0 || b === void 0) return a === b;
    if (a === null || b === null) return a === b;
    return a.host === b.host && a.user === b.user && String(a.port) === String(b.port);
  }
  function tunnelTarget(ts) {
    const t = ts && ts.target;
    if (!t || !t.host) return null;
    return { host: String(t.host), user: String(t.user || ""), port: String(t.port || 22) };
  }
  async function tunnelNow() {
    if (!(window.clutchTunnel && window.clutchTunnel.status)) return { active: false, target: null };
    try {
      const s = await window.clutchTunnel.status();
      return { active: !!(s && s.active), target: tunnelTarget(s) };
    } catch (e) {
      return { active: false, target: null };
    }
  }
  async function pinSlot(slotId, target) {
    if (!(window.clutchApi && window.clutchApi.setSlotTarget)) return;
    try {
      await window.clutchApi.setSlotTarget(slotId, target);
    } catch (e) {
    }
  }
  function rememberedMachine() {
    try {
      const list = JSON.parse(localStorage.getItem("clutch_ssh_connections") || "[]");
      const first = Array.isArray(list) ? list.find((c) => c && c.host) : null;
      if (first) return asMachine(first);
    } catch (e) {
    }
    try {
      const host = localStorage.getItem("clutch_ssh_host");
      if (!host) return null;
      return {
        host,
        user: localStorage.getItem("clutch_ssh_user") || "",
        port: String(localStorage.getItem("clutch_ssh_port") || 22)
      };
    } catch (e) {
      return null;
    }
  }
  function hopUpFor(tab) {
    if (!tab || !tab.machine) return true;
    if (!tab.base) return false;
    try {
      if (localStorage.getItem("clutch_ssh_connected") !== "1") return false;
    } catch (e) {
      return false;
    }
    return sameMachine(rememberedMachine(), tab.machine);
  }
  var dialing = false;
  async function dialMachine(m) {
    if (!m || dialing) return false;
    if (!(window.clutchTunnel && window.clutchTunnel.connect)) return false;
    dialing = true;
    try {
      const res = await window.clutchTunnel.connect({
        host: m.host,
        user: m.user,
        port: Number(m.port) || 22
      });
      return !!(res && res.ok);
    } catch (e) {
      return false;
    } finally {
      dialing = false;
    }
  }
  var autoConnectDoor = null;
  function onTabAutoConnect(fn) {
    autoConnectDoor = fn;
  }
  var autoDial = null;
  function autoConnect(m) {
    if (!autoConnectDoor) {
      return dialMachine(m).then(
        (ok) => ok ? "" : `could not reconnect to ${machineLabel(m)} \u2014 open the file picker and press Connect`
      );
    }
    if (autoDial && sameMachine(autoDial.m, m)) return autoDial.p;
    const p = autoConnectDoor(m).finally(() => {
      if (autoDial && autoDial.p === p) autoDial = null;
    });
    autoDial = { m, p };
    return p;
  }
  async function prepareTabMachine(tab) {
    const m = tab.machine;
    if (m === null) {
      await pinSlot(tab.id, { kind: "local" });
      return "";
    }
    if (!m) return "";
    const now = await tunnelNow();
    if (now.active && sameMachine(now.target, m)) {
      await pinSlot(tab.id, { kind: "tunnel" });
      return "";
    }
    const name = tab.name || tab.path;
    if (now.active) {
      return `${name} lives on ${machineLabel(m)}, but this window is on ${now.target ? machineLabel(now.target) : "another machine"} \u2014 connect to ${machineLabel(m)} in the file picker to open it`;
    }
    const why = await autoConnect(m);
    if (why) return `${name} lives on ${machineLabel(m)} \u2014 ${why}`;
    await pinSlot(tab.id, { kind: "tunnel" });
    return "";
  }
  async function noteTabMachine(tab) {
    if (!(window.clutchApi && window.clutchApi.slotStatus)) return;
    let st;
    try {
      st = await window.clutchApi.slotStatus(tab.id);
    } catch (e) {
      return;
    }
    if (!st || !st.claimed) return;
    let next = tab.machine;
    if (st.kind === "local") next = null;
    else if (st.kind === "tunnel") {
      const now = await tunnelNow();
      if (now.target) next = now.target;
    }
    if (sameMachine(tab.machine, next)) return;
    tab.machine = next;
    announceTabState();
    if (persistTabs) {
      try {
        persistTabs();
      } catch (e) {
      }
    }
  }
  var persistTabs = null;
  function onTabsPersist(cb) {
    persistTabs = cb;
  }
  function noSessionThere(tab) {
    return `${tab.name || tab.path} lives on ${machineLabel(tab.machine)} \u2014 no session there right now: connect to it in the file picker to open it`;
  }
  async function localClaimHasNoFile(tab) {
    if (!(window.clutchApi && window.clutchApi.slotStatus)) return false;
    let st;
    try {
      st = await window.clutchApi.slotStatus(tab.id);
    } catch (e) {
      return false;
    }
    if (!st || st.kind !== "local") return false;
    const dir = String(tab.path || "").replace(/\/[^/]*$/, "");
    if (!dir) return false;
    try {
      const r = await fetch(tab.base + "/api/fs/stat?path=" + encodeURIComponent(dir));
      if (!r.ok) return false;
      const body = await r.json();
      return !!(body && body.type === "none");
    } catch (e) {
      return false;
    }
  }
  async function claimTab(tab) {
    if (!tab) return null;
    if (!(window.clutchApi && window.clutchApi.baseUrl)) {
      return tab.base || null;
    }
    const why = await prepareTabMachine(tab);
    if (why) {
      tab.base = null;
      tab.unreachable = why;
      return null;
    }
    try {
      const base = await window.clutchApi.baseUrl(tab.id);
      tab.base = base ? String(base).replace(/\/+$/, "") : null;
      if (!tab.base) {
        if (tab.machine) tab.unreachable = noSessionThere(tab);
        return null;
      }
      tab.unreachable = null;
      if (tab.machine && await localClaimHasNoFile(tab)) {
        await releaseTab(tab);
        tab.unreachable = noSessionThere(tab);
        return null;
      }
      return tab.base;
    } catch (e) {
      console.warn("[slot] claim failed", tab.id, e);
      tab.base = null;
      return null;
    }
  }
  async function releaseTab(tab) {
    if (!tab) return;
    unwatchTab(tab.id);
    tab.running = false;
    tab.needsInput = false;
    if (window.clutchApi && window.clutchApi.releaseSession) {
      try {
        await window.clutchApi.releaseSession(tab.id);
      } catch (e) {
      }
    }
    tab.base = null;
  }
  function adoptBase(base) {
    const clean = base ? String(base).replace(/\/+$/, "") : "";
    state.apiBase = clean || null;
    try {
      if (clean) sessionStorage.setItem("clutch_api_url", clean);
    } catch (e) {
    }
    document.dispatchEvent(new CustomEvent("clutch:backend-changed", { detail: state.apiBase }));
  }
  var mementos = /* @__PURE__ */ new Map();
  var domCaches = /* @__PURE__ */ new Map();
  var MEMENTO_KEY = (slotId) => "clutch_view:" + slotId;
  function readStoredMemento(slotId) {
    try {
      const raw = localStorage.getItem(MEMENTO_KEY(slotId));
      if (!raw) return null;
      const m = JSON.parse(raw);
      if (!m || typeof m !== "object" || typeof m.high !== "number") return null;
      return {
        scroll: typeof m.scroll === "number" ? m.scroll : 0,
        high: typeof m.high === "number" ? m.high : null,
        oldest: typeof m.oldest === "number" ? m.oldest : null,
        older: typeof m.older === "number" ? m.older : 0,
        workdir: typeof m.workdir === "string" ? m.workdir : ""
      };
    } catch (e) {
      return null;
    }
  }
  function saveMemento(slotId, extra = {}) {
    if (!slotId) return;
    const stream2 = document.getElementById("stream");
    if (!stream2 || !paneShowsTab(slotId)) return;
    const m = {
      scroll: stream2.scrollTop,
      high: state.streamHighOffset,
      oldest: state.oldestOffset,
      older: typeof extra.older === "number" ? extra.older : 0,
      workdir: extra.workdir || ""
    };
    mementos.set(slotId, m);
    try {
      localStorage.setItem(MEMENTO_KEY(slotId), JSON.stringify(m));
    } catch (e) {
    }
  }
  function mementoOf(slotId) {
    return mementos.get(slotId) || readStoredMemento(slotId);
  }
  function forgetMemento(slotId) {
    mementos.delete(slotId);
    try {
      localStorage.removeItem(MEMENTO_KEY(slotId));
    } catch (e) {
    }
  }
  function restoreMemento(slotId) {
    const m = mementoOf(slotId);
    const stream2 = document.getElementById("stream");
    if (!m || !stream2) return null;
    const end = Math.max(0, stream2.scrollHeight - stream2.clientHeight);
    stream2.scrollTop = Math.max(0, Math.min(m.scroll, end));
    return stream2.scrollTop;
  }
  function viewIsSettled(eventsEl2) {
    if (!eventsEl2.children.length) return false;
    if (eventsEl2.querySelector(".stream, .live")) return false;
    for (const el of Array.from(eventsEl2.querySelectorAll(".fold, pre"))) {
      if (el.style.height || el.style.gridTemplateRows) return false;
    }
    return true;
  }
  function saveDomCache(slotId) {
    if (!slotId) return;
    const eventsEl2 = document.getElementById("events");
    const stream2 = document.getElementById("stream");
    if (!eventsEl2 || !stream2 || !paneShowsTab(slotId) || !viewIsSettled(eventsEl2)) {
      domCaches.delete(slotId);
      return;
    }
    const streamScrollTop = stream2.scrollTop;
    const nodes = document.createDocumentFragment();
    while (eventsEl2.firstChild) nodes.appendChild(eventsEl2.firstChild);
    domCaches.set(slotId, {
      nodes,
      streamScrollTop,
      stateSnapshot: {
        streamHighOffset: state.streamHighOffset,
        oldestOffset: state.oldestOffset,
        followTail: state.followTail,
        runSettled: state.runSettled,
        // the live pointers go with the nodes they name (see DomCache). They are
        // read here, while this tab is still the pane's, and put back by
        // restoreDomCache when it is the pane's again.
        lastTextEl: state.lastTextEl,
        lastTextContent: state.lastTextContent,
        textSealed: state.textSealed,
        // ...and the block a record drew, for the same reason: the final that repeats
        // it is replayed into the restored pane, and only this pointer says the answer
        // is already on the page (stream-events.ts)
        lastRecordEl: state.lastRecordEl,
        lastRecordText: state.lastRecordText,
        thinkingEl: state.thinkingEl,
        thinkingContent: state.thinkingContent,
        toolGroupEl: state.toolGroupEl,
        compactionEl: state.compactionEl,
        retryNoteEl: state.retryNoteEl
      }
    });
  }
  function restoreDomCache(slotId) {
    if (!slotId) return false;
    const cache = domCaches.get(slotId);
    const eventsEl2 = document.getElementById("events");
    const stream2 = document.getElementById("stream");
    if (!cache || !eventsEl2 || !stream2) return false;
    domCaches.delete(slotId);
    for (const node of Array.from(cache.nodes.childNodes)) {
      if (node.nodeType === 1) node.dataset.restored = "1";
    }
    eventsEl2.replaceChildren(cache.nodes);
    const end = Math.max(0, stream2.scrollHeight - stream2.clientHeight);
    stream2.scrollTop = Math.max(0, Math.min(cache.streamScrollTop, end));
    const s = cache.stateSnapshot;
    state.streamHighOffset = s.streamHighOffset;
    state.oldestOffset = s.oldestOffset;
    state.followTail = s.followTail;
    state.runSettled = s.runSettled;
    state.lastTextEl = s.lastTextEl || null;
    state.lastTextContent = s.lastTextContent || "";
    state.textSealed = !!s.textSealed;
    state.lastRecordEl = s.lastRecordEl || null;
    state.lastRecordText = s.lastRecordText || "";
    state.thinkingEl = s.thinkingEl || null;
    state.thinkingContent = s.thinkingContent || "";
    state.toolGroupEl = s.toolGroupEl || null;
    state.compactionEl = s.compactionEl || null;
    state.retryNoteEl = s.retryNoteEl || null;
    if (state.textRenderRaf) {
      cancelAnimationFrame(state.textRenderRaf);
      state.textRenderRaf = 0;
    }
    if (state.thinkingRenderRaf) {
      cancelAnimationFrame(state.thinkingRenderRaf);
      state.thinkingRenderRaf = 0;
    }
    return true;
  }
  function forgetDomCache(slotId) {
    domCaches.delete(slotId);
  }
  var watchers = /* @__PURE__ */ new Map();
  function watchTab(tab) {
    if (!tab || !tab.running || !tab.base || !tab.path) return;
    if (watchers.has(tab.id)) return;
    let es2;
    try {
      const qs = new URLSearchParams();
      qs.set("project", tab.projectKey || tab.path);
      qs.set("replay", "0");
      es2 = new EventSource(tab.base + "/api/events?" + qs.toString());
    } catch (e) {
      return;
    }
    es2.onmessage = (m) => {
      let ev;
      try {
        ev = JSON.parse(m.data);
      } catch (e) {
        return;
      }
      let changed = false;
      if (ev && ev.type === "state_update" && ev.key === "execution_status") {
        const running = ev.value === "running" || ev.value === "waiting";
        if (tab.running !== running) {
          tab.running = running;
          changed = true;
        }
      } else if (ev && ev.type === "permission_request") {
        if (!tab.needsInput) {
          tab.needsInput = true;
          changed = true;
        }
      } else if (ev && ev.type === "final") {
        if (tab.running || tab.needsInput) {
          tab.running = false;
          tab.needsInput = false;
          changed = true;
        }
        unwatchTab(tab.id);
      }
      if (changed) announceTabState();
    };
    es2.onerror = () => {
    };
    watchers.set(tab.id, es2);
  }
  function rewatchTab(tab) {
    if (!tab) return;
    unwatchTab(tab.id);
    if (!tab.running) return;
    watchTab(tab);
  }
  function unwatchTab(slotId) {
    const es2 = watchers.get(slotId);
    if (!es2) return;
    watchers.delete(slotId);
    try {
      es2.close();
    } catch (e) {
    }
  }
  function unwatchAll() {
    for (const id of [...watchers.keys()]) unwatchTab(id);
  }
  function noteTabEvent(slotId, ev) {
    const tab = tabForSlot(slotId);
    if (!tab || !ev || typeof ev !== "object") return false;
    let changed = false;
    if (ev.type === "state_update" && ev.key === "execution_status") {
      const running = ev.value === "running" || ev.value === "waiting";
      if (tab.running !== running) {
        tab.running = running;
        changed = true;
      }
    } else if (ev.type === "permission_request") {
      if (!tab.needsInput) {
        tab.needsInput = true;
        changed = true;
      }
    } else if (ev.type === "final") {
      if (tab.running || tab.needsInput) {
        tab.running = false;
        tab.needsInput = false;
        changed = true;
      }
    }
    if (changed) announceTabState();
    return true;
  }
  function setTabRunning(slotId, running) {
    const tab = tabForSlot(slotId);
    if (!tab) return;
    if (tab.running === running) return;
    tab.running = running;
    announceTabState();
  }

  // src/renderer/render-events.ts
  var driving = /* @__PURE__ */ new Set();
  function appendCompletion(status, summary) {
    const div = document.createElement("div");
    div.className = "completion";
    div.textContent = status === "completed" ? "completed" : status;
    (pageSink || eventsEl).appendChild(div);
    if (status !== "completed" && summary) {
      const note = document.createElement("div");
      note.className = "completion-note";
      note.textContent = summary;
      (pageSink || eventsEl).appendChild(note);
    }
    if (!stream.classList.contains("loading")) {
      if (gliding) return;
      if (state.followTail) stream.scrollTop = stream.scrollHeight;
      else setJumpVisible(true);
    }
  }
  function announce(name, detail) {
    if (typeof document === "undefined" || typeof document.dispatchEvent !== "function") return;
    const ev = typeof CustomEvent === "function" ? new CustomEvent(name, { detail }) : { type: name, detail };
    document.dispatchEvent(ev);
  }
  function announceProjectReadOnly(readOnly2) {
    announce("clutch:project-read-only", { readOnly: !!readOnly2 });
  }
  function announceProjectClaim(claimed2) {
    announce("clutch:project-claim", { claimed: !!claimed2 });
  }
  function renderEvent(ev) {
    const wrap = document.createElement("div");
    const body = document.createElement("div");
    body.className = "body";
    let appendedBody = false;
    switch (ev.type) {
      case "user_message": {
        const said = String(ev.content == null ? "" : ev.content);
        if (/^Your previous reply contained no visible text/.test(said)) {
          wrap.className = "event internal-note";
          wrap.innerHTML = '<div class="hdr">retry</div>';
          body.className = "body";
          body.textContent = "the model returned no visible text \u2014 asking again";
          break;
        }
        if (/^ERROR: The previous response hit the max_tokens limit/.test(said)) {
          wrap.className = "event internal-note";
          wrap.innerHTML = '<div class="hdr">retry</div>';
          body.className = "body";
          body.textContent = "the response hit max_tokens \u2014 asking again, more concisely";
          break;
        }
        wrap.className = "event user";
        wrap._taskText = said;
        wrap.innerHTML = '<div class="hdr">task</div>';
        body.className = "body";
        body.innerHTML = renderMarkdown(said, true);
        break;
      }
      case "tool_result": {
        const call = toolCalls[ev.tool_call_id] || { name: "", args: {}, ui: {} };
        const ui = uiOfResult(ev);
        if (ui.mutates) scheduleTreeRefresh();
        if (ui.form === "row") return buildResultRowBlock(ui, call, ev);
        return buildResultBlock(ui, call.name || "", call.args || {}, ev);
      }
      case "state_update": {
        if (typeof ev.read_only === "boolean") announceProjectReadOnly(ev.read_only);
        if (typeof ev.running_elsewhere === "boolean") announceProjectClaim(ev.running_elsewhere);
        if (ev.key === "running_elsewhere") announceProjectClaim(!!ev.value);
        if (ev.key === "execution_status" && ev.value) {
          if (ev.value === "idle" && state.sseRunAtRisk) {
            state.sseRunAtRisk = false;
            state.sseRunLostPending = true;
          } else if (ev.value !== "idle") {
            state.sseRunAtRisk = false;
          }
          setStatus(ev.value);
        }
        return null;
      }
      case "permission_request": {
        openPerm(ev);
        return null;
      }
      default:
        return null;
    }
    if (!appendedBody) wrap.appendChild(body);
    return wrap;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c]);
  }
  var markedTuned = false;
  function tuneMarked() {
    if (markedTuned || typeof marked === "undefined" || typeof marked.use !== "function") return;
    markedTuned = true;
    try {
      marked.use({
        tokenizer: {
          del(src) {
            const m = /^(~~)(?=[^\s~])([\s\S]*?[^\s~])\1(?=[^~]|$)/.exec(src);
            if (!m) return void 0;
            return { type: "del", raw: m[0], text: m[2], tokens: this.lexer.inlineTokens(m[2]) };
          }
        }
      });
    } catch (e) {
    }
  }
  function renderMarkdown(text, breaks = false) {
    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
      return escapeHtml(text);
    }
    tuneMarked();
    try {
      const src = String(text);
      const math = [];
      const protectedSrc = src.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, (m) => {
        math.push(m);
        return `\u27E6MATH${math.length - 1}\u27E7`;
      });
      const html = breaks ? marked.parse(protectedSrc, { breaks: true }) : marked.parse(protectedSrc);
      const restored = html.replace(/⟦MATH(\d+)⟧/g, (_, i) => math[+i]);
      return DOMPurify.sanitize(restored);
    } catch (e) {
      return escapeHtml(text);
    }
  }
  function renderDiff(diff) {
    const pre = document.createElement("pre");
    pre.className = "diff-view";
    const lines = diff.split("\n");
    for (const line of lines) {
      const div = document.createElement("div");
      div.textContent = line;
      if (line.startsWith("+++") || line.startsWith("---")) {
        div.className = "diff-hunk";
      } else if (line.startsWith("+")) {
        div.className = "diff-add";
      } else if (line.startsWith("-")) {
        div.className = "diff-del";
      } else if (line.startsWith("@")) {
        div.className = "diff-meta";
      }
      pre.appendChild(div);
    }
    return pre;
  }
  async function hostCall(promise) {
    const answer = await promise;
    if (answer && answer.ok === false) {
      const err = new Error(answer.error || "the host refused the call");
      err.code = answer.code || "host_error";
      if (answer.owner) err.owner = answer.owner;
      throw err;
    }
    return answer;
  }
  var pendingTask = "";
  function beginSend(task) {
    pendingTask = task;
    setStatus("sending");
  }
  function noteUserMessage(content) {
    if (!pendingTask || String(content == null ? "" : content).trim() !== pendingTask) return;
    const task = pendingTask;
    pendingTask = "";
    if (els.task.value.trim() === task) {
      els.task.value = "";
      els.task.style.height = TASK_BASE_H + "px";
    }
    recordSentTask(task);
    setStatus("running");
    const slotId = typeof activeSlotId === "function" ? activeSlotId() : "";
    if (typeof setTabRunning === "function") setTabRunning(slotId, true);
  }
  function endSend() {
    if (sending) setStatus("idle");
  }
  async function run() {
    const task = els.task.value.trim();
    if (busy || sending) return;
    if (!currentProject) return;
    const host = window.clutchRun;
    if (!host || typeof host.run !== "function") {
      notice("this build has no host run loop \u2014 it cannot run a task");
      return;
    }
    if (task) beginSend(task);
    state.followTail = true;
    autoScroll(true);
    const payload = { task: task || "", mode: agentMode, project: currentProject };
    const slotId = typeof activeSlotId === "function" ? activeSlotId() : "";
    if (!task) {
      setStatus("running");
      if (typeof setTabRunning === "function") setTabRunning(slotId, true);
    }
    try {
      driving.add(slotId);
      try {
        await hostCall(host.run(slotId, payload));
      } finally {
        driving.delete(slotId);
      }
    } catch (e) {
      const msg = e && e.message || e;
      pendingTask = "";
      if (e && e.code === "run_active") {
        console.info("[run] already driving this turn:", msg);
        setStatus("running");
        if (typeof setTabRunning === "function") setTabRunning(slotId, true);
        return;
      }
      if (!e || !e.code || e.code === "no_session") {
        connectionLost("could not reach the session to run the task (" + msg + ")");
      } else {
        addEvent({ type: "final", status: "error", summary: "run failed: " + msg });
      }
      setStatus("idle");
      if (typeof setTabRunning === "function") setTabRunning(slotId, false);
    } finally {
      endSend();
    }
  }
  async function stop() {
    const host = window.clutchRun;
    if (!host || typeof host.stop !== "function") {
      notice("this build has no host run loop \u2014 nothing to stop");
      return;
    }
    try {
      const slotId = typeof activeSlotId === "function" ? activeSlotId() : "";
      await hostCall(host.stop(slotId));
      if (typeof setTabRunning === "function") setTabRunning(slotId, false);
    } catch (e) {
      const msg = e && e.message || e;
      if (!e || !e.code || e.code === "no_session") {
        connectionLost("could not reach the session to stop the task (" + msg + ")");
      } else {
        notice("the backend refused to stop the task (" + msg + ") \u2014 it may still be running");
      }
      setStatus("idle");
      if (typeof switchBackendActiveSlot === "function") await switchBackendActiveSlot();
      else await switchBackendResolved();
    }
  }
  async function resumeTurn() {
    const host = window.clutchRun;
    if (!host || typeof host.state !== "function" || typeof host.drive !== "function") return;
    const slotId = typeof activeSlotId === "function" ? activeSlotId() : "";
    if (!currentProject || busy) return;
    if (driving.has(slotId)) return;
    let answer;
    try {
      answer = await hostCall(host.state(slotId, { mode: agentMode, project: currentProject }));
    } catch (e) {
      console.warn("[resume] no fold to resume from:", e && e.message || e);
      return;
    }
    if (!answer || !answer.result || answer.result.phase !== "open") return;
    setStatus("running");
    if (typeof setTabRunning === "function") setTabRunning(slotId, true);
    if (answer.driven) return;
    try {
      driving.add(slotId);
      try {
        await hostCall(host.drive(slotId));
      } finally {
        driving.delete(slotId);
      }
    } catch (e) {
      const msg = e && e.message || e;
      if (e && e.code === "run_active") {
        console.info("[resume] somebody is already driving this turn:", msg);
        return;
      }
      if (e && e.code === "run_elsewhere") {
        console.info("[resume] another window is running this turn:", msg);
        setStatus("idle");
        if (typeof setTabRunning === "function") setTabRunning(slotId, false);
        return;
      }
      if (!e || !e.code || e.code === "no_session") {
        connectionLost("could not reach the session to resume the turn (" + msg + ")");
      } else {
        notice("could not resume the turn (" + msg + ")");
      }
      setStatus("idle");
      if (typeof setTabRunning === "function") setTabRunning(slotId, false);
    }
  }
  if (window.clutchRun && typeof window.clutchRun.onEvent === "function") {
    window.clutchRun.onEvent((payload) => {
      const wrapped = payload && typeof payload === "object" && typeof payload.slotId === "string" && "event" in payload;
      const slotId = wrapped ? payload.slotId : activeSlotId();
      const ev = wrapped ? payload.event : payload;
      if (!ev || typeof ev !== "object") return;
      if (slotId && slotId !== activeSlotId()) {
        noteTabEvent(slotId, ev);
        return;
      }
      addEvent(ev);
    });
  }
  els.run.addEventListener("click", () => busy ? stop() : run());
  els.mode.addEventListener("click", () => {
    if (busy) return;
    setMode(agentMode === "chat" ? "work" : "chat");
  });
  setMode(agentMode);
  els.task.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
  });

  // src/renderer/stream-text.ts
  function createAgentTextBlock() {
    const wrap = document.createElement("div");
    wrap.className = "event text";
    wrap.innerHTML = '<div class="hdr">agent</div><div class="body"></div>';
    return wrap;
  }
  var textRenderLast = 0;
  var TEXT_RENDER_MIN_MS = 120;
  function renderTextBlock(force = false) {
    state.textRenderRaf = 0;
    const now = performance.now();
    if (!force && now - textRenderLast < TEXT_RENDER_MIN_MS) {
      state.textRenderRaf = requestAnimationFrame(() => renderTextBlock(false));
      return;
    }
    textRenderLast = now;
    if (!state.lastTextEl) return;
    paintTextBlock(state.lastTextEl, state.lastTextContent, force);
    autoScroll();
  }
  function paintTextBlock(el, text, settled = false) {
    const bodyEl = el.querySelector(".body");
    if (!bodyEl) return;
    bodyEl.innerHTML = renderMarkdown(text);
    el._mathDone = false;
    highlightCode(el, true);
    if (settled && !stream.classList.contains("loading")) {
      typesetMath(el);
      el._mathDone = true;
    }
  }
  function scheduleTextRender() {
    if (state.textRenderRaf) return;
    state.textRenderRaf = requestAnimationFrame(() => renderTextBlock(false));
  }
  function flushTextRender() {
    if (state.textRenderRaf) {
      cancelAnimationFrame(state.textRenderRaf);
      renderTextBlock(true);
    } else if (state.lastTextEl && !state.lastTextEl._mathDone && !stream.classList.contains("loading")) {
      typesetMath(state.lastTextEl);
      state.lastTextEl._mathDone = true;
    }
  }
  var thinkingRenderLast = 0;
  var THINKING_RENDER_MIN_MS = 120;
  function renderThinkingBlock(force = false) {
    state.thinkingRenderRaf = 0;
    if (!state.thinkingEl) return;
    const now = performance.now();
    if (!force && now - thinkingRenderLast < THINKING_RENDER_MIN_MS) {
      state.thinkingRenderRaf = requestAnimationFrame(() => renderThinkingBlock(false));
      return;
    }
    thinkingRenderLast = now;
    const label = state.thinkingEl.querySelector(".thinking-label");
    if (label) label.textContent = "thinking\u2026 " + state.thinkingContent.length + " chars";
    const full = state.thinkingEl.querySelector(".thinking-full");
    if (!full) return;
    full._content = state.thinkingContent;
    const fold = state.thinkingEl.querySelector(".fold");
    if (fold && !fold.classList.contains("hidden")) {
      const drawn = full._drawn;
      if (typeof drawn === "number" && drawn > 0 && drawn <= state.thinkingContent.length) {
        const add = state.thinkingContent.slice(drawn);
        if (add) full.appendChild(document.createTextNode(add));
      } else {
        full.textContent = state.thinkingContent;
      }
      full._drawn = state.thinkingContent.length;
    }
    autoScroll();
  }
  function scheduleThinkingRender() {
    if (state.thinkingRenderRaf) return;
    state.thinkingRenderRaf = requestAnimationFrame(() => renderThinkingBlock(false));
  }
  function flushThinkingRender() {
    if (!state.thinkingRenderRaf) return;
    cancelAnimationFrame(state.thinkingRenderRaf);
    renderThinkingBlock(true);
  }
  var ARRIVE_EASE = "cubic-bezier(.23, 1, .32, 1)";
  var LEAVE_EASE = "cubic-bezier(.4, 0, 1, 1)";
  var FOLD_MS = 200;
  var FOLD_SIZE_MS = 420;
  var FOLD_PX = 1e3;
  function foldContentPx(fold) {
    const inner = fold.firstElementChild;
    return inner && typeof inner.scrollHeight === "number" ? inner.scrollHeight : 0;
  }
  function foldMoveMs(fold) {
    const px = foldContentPx(fold);
    return Math.max(FOLD_MS, Math.min(FOLD_SIZE_MS, Math.round(px * FOLD_SIZE_MS / FOLD_PX)));
  }
  function foldProgress(el) {
    const anim = el && el._foldAnim;
    const timing = anim && anim.effect && anim.effect.getComputedTiming ? anim.effect.getComputedTiming() : null;
    return timing && typeof timing.progress === "number" ? timing.progress : 1;
  }
  function foldBody(fold) {
    const inner = fold.firstElementChild;
    const body = inner ? inner.firstElementChild : null;
    return body && body.classList && body.classList.contains("fold-body") ? body : null;
  }
  function foldHead(fold) {
    const head = fold.previousElementSibling;
    return head && head.classList && head.classList.contains("turn-fold-head") ? head : null;
  }
  function headLag(fold) {
    const block = fold.parentElement;
    if (!block) return 0;
    const pane2 = stream.getBoundingClientRect();
    return Math.max(0, pane2.top + stream.clientTop - block.getBoundingClientRect().top);
  }
  var foldScrollHold = 0;
  function foldHoldsScroll() {
    return foldScrollHold > 0;
  }
  function giveBack(fold) {
    if (!fold._scrollLag) return;
    stream.scrollTop = fold._scrollFrom - fold._scrollLag * foldProgress(fold);
  }
  function stopGiveBack(fold) {
    if (fold._scrollRaf) cancelAnimationFrame(fold._scrollRaf);
    fold._scrollRaf = 0;
    if (fold._scrollHold) {
      foldScrollHold--;
      fold._scrollHold = false;
    }
  }
  function cancelFoldAnim(el) {
    if (el._foldAnim) {
      try {
        el._foldAnim.cancel();
      } catch (e) {
      }
    }
    el._foldAnim = null;
    if (el._bodyAnim) {
      try {
        el._bodyAnim.cancel();
      } catch (e) {
      }
    }
    el._bodyAnim = null;
    stopGiveBack(el);
  }
  function animateFold(el, from, to, onDone) {
    cancelFoldAnim(el);
    el.style.overflowY = "hidden";
    el.style.height = from + "px";
    const settle = () => {
      cancelFoldAnim(el);
      onDone();
      if (state.followTail && !stream.classList.contains("loading")) autoScroll();
    };
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.style.height = to + "px";
      settle();
      return;
    }
    const anim = el.animate(
      [{ height: from + "px" }, { height: to + "px" }],
      { duration: FOLD_MS, easing: to >= from ? ARRIVE_EASE : LEAVE_EASE, fill: "forwards" }
    );
    el._foldAnim = anim;
    anim.onfinish = settle;
    followTailDuring(anim);
  }
  function resetFold(el) {
    el.style.height = "";
    el.style.overflowY = "";
  }
  function expandDiff(pre) {
    const start = pre.offsetHeight;
    pre.classList.remove("diff-collapsed");
    const target = Math.min(pre.scrollHeight, 320);
    animateFold(pre, start, target, () => resetFold(pre));
  }
  function collapseDiff(pre) {
    animateFold(pre, pre.offsetHeight, 140, () => {
      pre.classList.add("diff-collapsed");
      resetFold(pre);
    });
  }
  function wrapFold(contentEl) {
    const inner = document.createElement("div");
    inner.className = "fold-inner";
    inner.appendChild(contentEl);
    const fold = document.createElement("div");
    fold.className = "fold hidden";
    fold.appendChild(inner);
    return fold;
  }
  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function followTailDuring(anim) {
    let raf = requestAnimationFrame(function tick() {
      if (state.followTail && !stream.classList.contains("loading")) autoScroll();
      raf = requestAnimationFrame(tick);
    });
    const stop2 = () => cancelAnimationFrame(raf);
    anim.addEventListener("finish", stop2, { once: true });
    anim.addEventListener("cancel", stop2, { once: true });
  }
  function foldFraction(fold) {
    if (!fold._foldAnim || typeof fold._foldFrom !== "number") {
      return fold.classList.contains("hidden") ? 0 : 1;
    }
    return fold._foldFrom + (fold._foldTo - fold._foldFrom) * foldProgress(fold);
  }
  function foldBodyY(fold) {
    if (typeof fold._bodyFrom !== "number") return 0;
    return fold._bodyFrom + (fold._bodyTo - fold._bodyFrom) * foldProgress(fold);
  }
  function foldOpen(fold) {
    return fold._foldAnim ? !!fold._foldTarget : !fold.classList.contains("hidden");
  }
  function foldAnim(fold, open, onDone = null) {
    const from = foldFraction(fold);
    const fromY = foldBodyY(fold);
    const to = open ? 1 : 0;
    cancelFoldAnim(fold);
    fold.classList.remove("hidden");
    fold.classList.add("open");
    const size = foldContentPx(fold);
    const at = (f) => Math.round(size * f) + "px";
    fold.style.gridTemplateRows = "1fr";
    fold.style.height = at(from);
    const body = foldBody(fold);
    const lag = open || !foldHead(fold) ? 0 : headLag(fold);
    fold.classList.toggle("open", open);
    if (reducedMotion()) {
      fold.style.height = "";
      fold.style.gridTemplateRows = "";
      if (!open) fold.classList.add("hidden");
      if (lag) stream.scrollTop -= lag;
      if (open) autoScroll();
      queueStuck();
      if (onDone) onDone();
      return;
    }
    const ms = foldMoveMs(fold);
    const easing = open || body ? ARRIVE_EASE : LEAVE_EASE;
    const anim = fold.animate(
      [
        { height: at(from), opacity: 1 },
        { height: at(to), opacity: open || body ? 1 : 0 }
      ],
      { duration: ms, easing }
    );
    fold._foldAnim = anim;
    fold._foldFrom = from;
    fold._foldTo = to;
    fold._foldTarget = open;
    fold._scrollFrom = stream.scrollTop;
    fold._scrollLag = lag;
    if (lag > 1) {
      foldScrollHold++;
      fold._scrollHold = true;
      const trackScroll = () => {
        giveBack(fold);
        fold._scrollRaf = requestAnimationFrame(trackScroll);
      };
      fold._scrollRaf = requestAnimationFrame(trackScroll);
    }
    if (body) {
      fold._bodyFrom = fromY;
      fold._bodyTo = open ? 0 : -size;
      fold._bodyAnim = body.animate(
        [
          { transform: "translateY(" + fromY + "px)" },
          { transform: "translateY(" + fold._bodyTo + "px)" }
        ],
        { duration: ms, easing }
      );
    }
    anim.onfinish = () => {
      fold._foldAnim = null;
      giveBack(fold);
      fold._scrollLag = 0;
      stopGiveBack(fold);
      fold.style.height = "";
      fold.style.gridTemplateRows = "";
      fold._bodyAnim = null;
      fold._bodyFrom = fold._bodyTo = 0;
      if (!open) fold.classList.add("hidden");
      if (onDone) onDone();
      queueStuck();
    };
    if (open) followTailDuring(anim);
    queueStuck();
  }
  function foldExpand(fold) {
    foldAnim(fold, true);
  }
  function foldCollapse(fold, onDone = null) {
    foldAnim(fold, false, onDone);
  }
  function toggleFold(fold, onExpand = null) {
    const open = foldOpen(fold);
    if (open) {
      foldCollapse(fold);
    } else {
      if (onExpand) onExpand();
      foldExpand(fold);
    }
    return !open;
  }
  var stuckRaf = 0;
  function paintStuck() {
    stuckRaf = 0;
    const heads = stream.querySelectorAll(".turn-fold-head");
    if (!heads.length) return;
    const pane2 = stream.getBoundingClientRect().top;
    const state2 = [];
    for (const head of heads) {
      const block = head.parentElement;
      const fold = head.nextElementSibling;
      state2.push([head, !!(block && fold && block.getBoundingClientRect().top < pane2 - 0.5 && fold.getBoundingClientRect().bottom > pane2 + 1)]);
    }
    for (const [head, stuck] of state2) head.classList.toggle("stuck", stuck);
  }
  function queueStuck() {
    if (stuckRaf) return;
    stuckRaf = requestAnimationFrame(paintStuck);
  }
  stream.addEventListener("scroll", queueStuck, { passive: true });
  window.addEventListener("resize", queueStuck);
  function buildThinkingBlock(initialLabel, initialContent) {
    const el = document.createElement("div");
    el.className = "event thinking";
    el.innerHTML = '<div class="hdr">thinking</div>';
    const row = document.createElement("div");
    row.className = "thinking-row";
    const toggle = document.createElement("span");
    toggle.className = "fold-toggle";
    toggle.textContent = "\u25B8";
    const lbl = document.createElement("span");
    lbl.className = "thinking-label";
    lbl.textContent = initialLabel;
    row.appendChild(toggle);
    row.appendChild(lbl);
    el.appendChild(row);
    const full = document.createElement("pre");
    full.className = "thinking-full";
    full.textContent = initialContent;
    full._content = initialContent;
    full._drawn = initialContent.length;
    const fold = wrapFold(full);
    el.appendChild(fold);
    row.onclick = () => {
      const wasHidden = toggleFold(fold, () => {
        full.textContent = full._content;
        full._drawn = full._content.length;
      });
      toggle.textContent = wasHidden ? "\u25BE" : "\u25B8";
    };
    return { el, full, fold };
  }
  function appendThinkingRow(reasoning) {
    const block = buildThinkingBlock("thinking", reasoning);
    (pageSink || eventsEl).appendChild(block.el);
  }

  // src/renderer/stream-view.ts
  var busy = false;
  var jumpBottom = $("#jump-bottom");
  var JUMP_BOTTOM_GAP = 80;
  function nearBottom() {
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight < JUMP_BOTTOM_GAP;
  }
  function setJumpVisible(visible) {
    jumpBottom.classList.toggle("hidden", !visible);
  }
  var lastScrollTop = 0;
  var catchUp = false;
  var gliding = false;
  var glideRaf = 0;
  function beginCatchUp() {
    catchUp = true;
  }
  function endCatchUp() {
    if (!catchUp) return;
    catchUp = false;
    autoScroll();
  }
  function autoScroll(force = false) {
    if (stream.classList.contains("loading")) return;
    if (typeof foldHoldsScroll === "function" && foldHoldsScroll() && !force) return;
    if (catchUp && !force) return;
    if (force) {
      if (state.followTail) {
        if (glideRaf) {
          cancelAnimationFrame(glideRaf);
          glideRaf = 0;
        }
        gliding = false;
        stream.scrollTop = stream.scrollHeight;
        setJumpVisible(false);
      } else {
        glideToBottom();
      }
      return;
    }
    if (state.followTail) {
      if (gliding) return;
      stream.scrollTop = stream.scrollHeight;
      setJumpVisible(false);
    } else {
      setJumpVisible(true);
    }
  }
  function glideToBottom() {
    if (stream.classList.contains("loading")) return;
    cancelAnimationFrame(glideRaf);
    const target = stream.scrollHeight;
    if (stream.scrollTop >= target - 1) {
      gliding = false;
      state.followTail = true;
      setJumpVisible(false);
      return;
    }
    gliding = true;
    if (reducedMotion()) {
      stream.scrollTop = stream.scrollHeight;
      gliding = false;
      state.followTail = true;
      setJumpVisible(false);
      return;
    }
    stream.scrollTo({ top: target, behavior: "smooth" });
    const finish = () => {
      const bottom = stream.scrollHeight - stream.clientHeight;
      if (!gliding || Math.abs(stream.scrollTop - target) < 2 || Math.abs(stream.scrollTop - bottom) < 2) {
        gliding = false;
        state.followTail = true;
        setJumpVisible(false);
        if (!stream.classList.contains("loading")) {
          stream.scrollTop = stream.scrollHeight;
        }
        return;
      }
      glideRaf = requestAnimationFrame(finish);
    };
    glideRaf = requestAnimationFrame(finish);
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (state.followTail && !stream.classList.contains("loading")) autoScroll();
    }).observe(eventsEl);
  }
  jumpBottom.addEventListener("click", () => {
    autoScroll(true);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "ArrowDown") {
      autoScroll(true);
    }
  });
  var prevClientH = stream.clientHeight;
  var prevScrollH = stream.scrollHeight;
  stream.addEventListener("scroll", (e) => {
    const cur = stream.scrollTop;
    if (!e.isTrusted) {
      lastScrollTop = cur;
      prevClientH = stream.clientHeight;
      prevScrollH = stream.scrollHeight;
      return;
    }
    const viewportChanged = stream.clientHeight !== prevClientH;
    prevClientH = stream.clientHeight;
    const scrollShrank = stream.scrollHeight < prevScrollH;
    prevScrollH = stream.scrollHeight;
    if (viewportChanged || scrollShrank || performance.now() < state.suppressLatchUntil) {
      lastScrollTop = cur;
      return;
    }
    if (glideRaf) {
      cancelAnimationFrame(glideRaf);
      glideRaf = 0;
    }
    gliding = false;
    const up = cur < lastScrollTop && !nearBottom();
    if (up) {
      state.followTail = false;
    } else if (nearBottom()) state.followTail = true;
    lastScrollTop = cur;
    setJumpVisible(!state.followTail);
  }, { passive: true });
  var sending = false;
  var readOnly = false;
  var claimed = false;
  function setReadOnly(on) {
    const next = !!on;
    if (next === readOnly) return;
    readOnly = next;
    paintControls();
  }
  function setClaimed(on) {
    const next = !!on;
    if (next === claimed) return;
    claimed = next;
    paintControls();
  }
  function setStatus(state2) {
    const now = state2 || "idle";
    sending = now === "sending";
    els.status.className = "badge " + now;
    els.status.textContent = now;
    busy = now === "running" || now === "waiting";
    document.dispatchEvent(new CustomEvent("clutch:status-changed", { detail: now }));
    paintControls();
  }
  function paintControls() {
    els.run.textContent = sending ? "Sending" : busy ? "\u25A0 Stop" : "\u25B6 Run";
    els.run.title = sending ? "the message is on its way \u2014 it leaves the box when the session has it" : busy ? "stop the running task" : claimed ? "another window is running this project \u2014 the composer is yours again when that run ends" : readOnly ? "this project is open read-only here \u2014 a run needs a writable open" : "run the task \u2014 Cmd/Ctrl+Enter in the box";
    els.run.classList.toggle("stop-mode", busy);
    els.run.classList.toggle("sending", sending);
    els.run.disabled = sending ? true : busy ? false : !currentProject || readOnly || claimed;
    els.task.readOnly = sending || readOnly || claimed;
    if (sending) els.task.setAttribute("aria-busy", "true");
    else els.task.removeAttribute("aria-busy");
    els.mode.disabled = busy || sending || readOnly || claimed;
    els.mode.title = busy || sending ? "A run is in progress; the mode applies to the next run." : readOnly || claimed ? "This stream is read-only; the mode applies to a later run." : "chat: read-only analysis \xB7 work: full access (write/edit/any command). Applies to the next run.";
    if (els.claim) els.claim.classList.toggle("hidden", !claimed);
  }
  var toolCalls = {};
  var toolCallGroups = /* @__PURE__ */ new Map();

  // src/renderer/markdown.ts
  var MATH_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$/;
  function typesetMath(el) {
    if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
    if (!el || !MATH_RE.test(el.textContent)) return;
    MathJax.typesetPromise([el]).then(() => autoScroll()).catch(() => {
    });
  }
  function hasMathText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("pre, code").forEach((n) => n.remove());
    return MATH_RE.test(clone.textContent);
  }
  async function typesetProgressively(root, onPct) {
    if (typeof MathJax === "undefined" || typeof MathJax.typesetPromise !== "function") return;
    const blocks = Array.from(root.querySelectorAll(".event.text .body, .event.user .body")).filter(hasMathText);
    if (!blocks.length) return;
    for (let i = 0; i < blocks.length; i++) {
      try {
        await MathJax.typesetPromise([blocks[i]]);
      } catch (e) {
      }
      onPct((i + 1) / blocks.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  var hlCache = /* @__PURE__ */ new Map();
  var HL_CACHE_MAX = 64;
  var HL_STREAM_MAX = 16384;
  var HL_CACHE_MAX_SRC = 131072;
  function highlightCode(root, streaming = false) {
    if (typeof hljs === "undefined" || !root) return;
    root.querySelectorAll("pre code").forEach((el) => {
      const src = el.textContent;
      const cached = hlCache.get(src);
      if (cached !== void 0) {
        if (el.innerHTML !== cached) el.innerHTML = cached;
        return;
      }
      if (streaming && src.length > HL_STREAM_MAX) return;
      try {
        hljs.highlightElement(el);
        if (src.length <= HL_CACHE_MAX_SRC) {
          if (hlCache.size >= HL_CACHE_MAX) hlCache.delete(hlCache.keys().next().value);
          hlCache.set(src, el.innerHTML);
        }
      } catch (e) {
      }
    });
    renderMermaid(root, streaming).catch((e) => console.warn("[mermaid]", e));
  }
  var mermaidInitialized = false;
  var mermaidCache = /* @__PURE__ */ new Map();
  function isLastElement(pre) {
    let n = pre.nextSibling;
    while (n) {
      if (n.nodeType === 1) return false;
      if (n.nodeType === 3 && n.textContent.trim()) return false;
      n = n.nextSibling;
    }
    return true;
  }
  function initMermaidTheme() {
    try {
      const cssValue = (name) => (getComputedStyle(document.documentElement).getPropertyValue(name) || "").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").trim();
      const accent = cssValue("--accent") || "#EF4444";
      const diagramFont = cssValue("--font-display") || "sans-serif";
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        themeVariables: {
          fontFamily: diagramFont,
          // strokes & lines: accent red
          lineColor: accent,
          primaryBorderColor: accent,
          secondaryBorderColor: accent,
          tertiaryBorderColor: accent,
          // sequence diagram
          actorBorder: accent,
          actorLineColor: accent,
          signalColor: accent,
          labelBoxBorderColor: accent,
          noteBorderColor: accent,
          activationBorderColor: accent,
          // gantt: active = red fill, planned = grey, done = darker grey
          taskBorderColor: accent,
          taskBkgColor: "#2d2d33",
          taskBkg: "#2d2d33",
          // harmless alias for any theme that reads it
          taskTextColor: "#d4d4d8",
          taskTextLightColor: "#d4d4d8",
          activeTaskBorderColor: accent,
          activeTaskBkgColor: accent,
          activeTaskBkg: accent,
          activeTaskTextColor: "#0F0F10",
          doneTaskBorderColor: "#52525b",
          doneTaskBkgColor: "#1c1c1f",
          doneTaskBkg: "#1c1c1f",
          doneTaskTextColor: "#a1a1aa",
          todayLineColor: accent,
          // clusters / subgraphs
          clusterBorder: accent,
          // state diagrams: also override the outer container's legacy border1
          stateBorder: accent,
          border1: accent,
          // fills & labels: neutral dark greys
          noteBkgColor: "#1c1c1f",
          noteTextColor: "#d4d4d8",
          edgeLabelBackground: "#1c1c1f",
          clusterBkg: "#1c1c1f",
          taskTextOutsideColor: "#a1a1aa",
          activationBkgColor: "#27272a",
          // pie: first slice red, rest grayscale (pie0 unused)
          pie1: accent,
          pie2: "#27272a",
          pie3: "#3f3f46",
          pie4: "#52525b",
          pie5: "#71717a",
          pie6: "#8b8b94",
          pie7: "#a1a1aa",
          pie8: "#b8b8c0",
          pie9: "#c9c9d0",
          pie10: "#d4d4d8",
          pie11: "#e0e0e4",
          pie12: "#ededf0",
          // git graphs: grayscale + red (git0-git7)
          git0: accent,
          git1: "#71717a",
          git2: "#d4d4d8",
          git3: "#3f3f46",
          git4: "#a1a1aa",
          git5: "#27272a",
          git6: "#b8b8c0",
          git7: "#52525b"
        }
      });
      mermaid.parseError = (err) => console.warn("[mermaid]", err);
      return true;
    } catch (e) {
      return false;
    }
  }
  async function renderMermaid(root, streaming = false) {
    if (typeof mermaid === "undefined" || !root) return;
    if (!mermaidInitialized) {
      mermaidInitialized = true;
      if (!initMermaidTheme()) return;
    }
    const pending = [];
    for (const code of root.querySelectorAll("pre code.language-mermaid")) {
      const pre = code.parentElement;
      if (!pre) continue;
      const src = code.textContent;
      if (pre.dataset.mermaidSrc === src) continue;
      const cached = mermaidCache.get(src);
      if (cached) {
        pre.classList.add("mermaid-rendered");
        pre.textContent = "";
        pre.insertAdjacentHTML("beforeend", cached);
        pre.dataset.mermaidSrc = src;
        continue;
      }
      if (streaming && isLastElement(pre)) continue;
      let parsed = true;
      let parseErr = null;
      try {
        parsed = await mermaid.parse(src);
      } catch (e) {
        parsed = false;
        parseErr = e;
      }
      if (!parsed) {
        showMermaidError(pre, parseErr);
        pre.dataset.mermaidSrc = src;
        continue;
      }
      pre.dataset.mermaidSrc = src;
      pending.push({ pre, src });
    }
    for (const { pre, src } of pending) {
      mermaid.render("mmd-" + Math.random().toString(36).slice(2), src).then(({ svg }) => {
        let target = null;
        for (const el of root.querySelectorAll("pre code.language-mermaid")) {
          if (el.textContent === src) {
            target = el.parentElement;
            break;
          }
        }
        if (!target) return;
        if (/Parse error on line|Lexical error on line|Syntax error in text|Parse error[:\s]/.test(svg)) {
          showMermaidError(target, null);
          delete target.dataset.mermaidSrc;
          return;
        }
        if (mermaidCache.size > 100) mermaidCache.clear();
        mermaidCache.set(src, svg);
        target.classList.add("mermaid-rendered");
        target.textContent = "";
        target.insertAdjacentHTML("beforeend", svg);
        target.dataset.mermaidSrc = src;
        if (state.followTail) autoScroll();
      }).catch((e) => {
        if (pre.isConnected) {
          showMermaidError(pre, e);
          delete pre.dataset.mermaidSrc;
        }
      });
    }
  }
  function showMermaidError(pre, detail) {
    if (!pre || !pre.classList) return;
    pre.classList.add("mermaid-failed");
    if (!pre.querySelector(".mermaid-error")) {
      const tip = document.createElement("div");
      tip.className = "mermaid-error";
      tip.textContent = "Invalid diagram syntax; the original code was kept.";
      const msg = detail && (detail.message || String(detail));
      if (msg) tip.title = "mermaid: " + msg;
      pre.appendChild(tip);
    }
  }

  // src/renderer/sse-stream.ts
  var es = null;
  var SSE_KEEPALIVE_MS = 15e3;
  var SSE_STALE_MS = SSE_KEEPALIVE_MS * 3;
  var SSE_ERROR_WINDOW_MS = 3e4;
  var sseLastFrameAt = 0;
  var sseErrorsSince = 0;
  var sseDown = false;
  var sseWatchdog = null;
  var sseSuspended = false;
  var SSE_RUN_LOST = "the session running this task went away while it was in flight \u2014 nothing is running now";
  function sseFrame() {
    sseLastFrameAt = Date.now();
    sseDown = false;
  }
  function sseDegrade(reason) {
    if (sseDown) return;
    sseDown = true;
    connectionLost("lost the live stream (" + reason + ")");
  }
  function sseWatchdogTick() {
    if (!state.apiBase || !es) return;
    if (document.hidden) {
      sseSuspend();
      return;
    }
    if (sseSuspended) {
      sseResume();
      return;
    }
    if (Date.now() - sseLastFrameAt < SSE_STALE_MS) return;
    sseLastFrameAt = Date.now();
    sseDegrade("no keepalive for " + Math.round(SSE_STALE_MS / 1e3) + "s");
    reconnectSSE();
  }
  function sseSuspend() {
    sseSuspended = true;
  }
  function sseResume() {
    if (!sseSuspended) return;
    sseSuspended = false;
    sseLastFrameAt = Date.now();
    if (!state.apiBase || !es) return;
    reconnectSSE();
  }
  document.addEventListener("visibilitychange", () => document.hidden ? sseSuspend() : sseResume());
  document.addEventListener("freeze", sseSuspend);
  document.addEventListener("resume", sseResume);
  window.addEventListener("pagehide", sseSuspend);
  window.addEventListener("pageshow", sseResume);
  function startSseWatchdog() {
    if (sseWatchdog) return;
    sseWatchdog = setInterval(sseWatchdogTick, 5e3);
  }
  function connectSSE() {
    if (!state.apiBase) return;
    settleCatchUp();
    if (es) es.close();
    const qs = new URLSearchParams();
    if (currentProject) qs.set("project", currentProject);
    if (state.streamHighOffset !== null) qs.set("since", String(state.streamHighOffset));
    es = new EventSource(state.apiBase + "/api/events?" + qs.toString());
    sseFrame();
    es.onmessage = (e) => {
      sseFrame();
      try {
        addEvent(JSON.parse(e.data));
      } catch (err) {
        console.warn("[sse] undecodable event", err);
      }
    };
    es.addEventListener("ping", sseFrame);
    es.onopen = () => {
      sseErrorsSince = 0;
      sseFrame();
      resolveConnectionLost();
      if (typeof pushTrustArmed === "function") pushTrustArmed();
      dropOrphanLive();
      if (!currentProject) refreshTree();
    };
    es.onerror = () => {
      settleCatchUp();
      if (!sseErrorsSince) sseErrorsSince = Date.now();
      if (Date.now() - sseErrorsSince >= SSE_ERROR_WINDOW_MS) {
        sseDegrade("the backend did not answer for " + Math.round(SSE_ERROR_WINDOW_MS / 1e3) + "s");
      }
    };
    startSseWatchdog();
  }
  function reconnectSSE() {
    connectSSE();
  }
  function closeSSE() {
    settleCatchUp();
    if (!es) return;
    try {
      es.close();
    } catch (e) {
    }
    es = null;
  }

  // src/renderer/task-rollback.ts
  var LONG_PRESS_MS = 500;
  var LONG_PRESS_SLOP_PX = 12;
  var ROLLBACK_GESTURE_DEDUPE_MS = 800;
  var rollbackAnchors = null;
  var rollbackBusy = false;
  var lastRollbackGestureAt = 0;
  function resetRollbackAnchors() {
    rollbackAnchors = null;
  }
  async function refreshRollbackAnchors() {
    try {
      const data = await apiFetch("/api/workspace/checkpoints");
      rollbackAnchors = new Set((data.anchors || []).map(Number));
    } catch (e) {
      rollbackAnchors = null;
    }
  }
  function rowTaskText(el) {
    return el && typeof el._taskText === "string" ? el._taskText : "";
  }
  function openRollbackMenu(el) {
    const now = performance.now();
    if (now - lastRollbackGestureAt < ROLLBACK_GESTURE_DEDUPE_MS) return;
    lastRollbackGestureAt = now;
    if (rollbackBusy) return;
    const offset = Number(el.dataset.offset);
    if (!Number.isFinite(offset)) return;
    if (busy) {
      notice("a run is active \u2014 stop it before rolling the workspace back");
      return;
    }
    if (rollbackAnchors && !rollbackAnchors.has(offset)) {
      notice("that message left no file changes to roll back", "info");
      return;
    }
    rollbackTo(el, offset);
  }
  async function rollbackTo(el, offset) {
    const ok = await askConfirm({
      title: "Roll back to this message",
      text: "Every file change made after this message is undone \u2014 files it created are\ndeleted, files it overwrote are restored to what they held before.\nThe message goes back into the input box; the transcript is kept.\nChanges made by shell commands (sed, mv, rm) are not tracked.",
      ok: "Roll back"
    });
    if (!ok) return;
    rollbackBusy = true;
    try {
      const data = await apiFetch("/api/workspace/rollback", { method: "POST", body: { offset } });
      const n = data.count || 0;
      notice(
        `rolled back ${n} file${n === 1 ? "" : "s"}` + (data.deleted && data.deleted.length ? ` (${data.deleted.length} deleted)` : ""),
        "info"
      );
      fillTaskInput(rowTaskText(el));
      refreshTree();
      await refreshRollbackAnchors();
    } catch (e) {
      notice("roll back failed: " + (e && e.message || e));
      refreshRollbackAnchors();
    } finally {
      rollbackBusy = false;
    }
  }
  eventsEl.addEventListener("contextmenu", (e) => {
    const t = e.target;
    const el = t && t.closest ? t.closest(".event.user") : null;
    if (!el) return;
    e.preventDefault();
    openRollbackMenu(el);
  });
  var pressTimer = 0;
  var pressEl = null;
  var pressFrom = null;
  function cancelPress() {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = 0;
    pressEl = null;
    pressFrom = null;
  }
  eventsEl.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return cancelPress();
      const src = e.target;
      const el = src && src.closest ? src.closest(".event.user") : null;
      if (!el) return;
      const t = e.touches[0];
      cancelPress();
      pressEl = el;
      pressFrom = { x: t.clientX, y: t.clientY };
      pressTimer = setTimeout(() => {
        const target = pressEl;
        pressTimer = 0;
        pressEl = null;
        pressFrom = null;
        if (target) openRollbackMenu(target);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );
  eventsEl.addEventListener(
    "touchmove",
    (e) => {
      if (!pressFrom || !e.touches.length) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - pressFrom.x, t.clientY - pressFrom.y) > LONG_PRESS_SLOP_PX) cancelPress();
    },
    { passive: true }
  );
  eventsEl.addEventListener("touchend", cancelPress, { passive: true });
  eventsEl.addEventListener("touchcancel", cancelPress, { passive: true });

  // src/renderer/project.ts
  var currentProject = "";
  var openSeq = 0;
  var openAbort = null;
  var viewAbort = null;
  var opening = null;
  function supersedeOpen() {
    openSeq++;
    if (openAbort) {
      try {
        openAbort.abort();
      } catch (e) {
      }
      openAbort = null;
    }
    if (viewAbort) {
      try {
        viewAbort.abort();
      } catch (e) {
      }
      viewAbort = null;
    }
    return openSeq;
  }
  function isStale(seq, e) {
    return seq !== openSeq || !!(e && e.name === "AbortError");
  }
  function dirOf(path) {
    if (!path) return "";
    const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return at > 0 ? path.slice(0, at) : "";
  }
  function clearStream() {
    eventsEl.innerHTML = "";
    state.lastTextEl = null;
    state.lastTextContent = "";
    state.textSealed = false;
    state.lastRecordEl = null;
    state.lastRecordText = "";
    state.thinkingEl = null;
    state.thinkingContent = "";
    if (state.textRenderRaf) {
      cancelAnimationFrame(state.textRenderRaf);
      state.textRenderRaf = 0;
    }
    if (state.thinkingRenderRaf) {
      cancelAnimationFrame(state.thinkingRenderRaf);
      state.thinkingRenderRaf = 0;
    }
    state.compactionEl = null;
    state.retryNoteEl = null;
    state.oldestOffset = null;
    state.streamHighOffset = null;
    state.runSettled = false;
    state.owedRecords.length = 0;
    endCatchUp();
    resetRollbackAnchors();
    setOlderPill(0);
  }
  var olderRemaining = 0;
  var olderOwner = false;
  var paging = false;
  var olderBusy = "";
  var pageSink = null;
  function olderSizeLabel(bytes) {
    const kb = Math.max(1, Math.ceil(bytes / 1024));
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
  }
  function paintOlderLabel() {
    const label = document.getElementById("older-label");
    if (!label) return;
    const size = olderSizeLabel(olderRemaining);
    if (olderBusy === "render") label.textContent = "rendering earlier records\u2026";
    else if (olderBusy === "fetch") label.textContent = `loading ${size}\u2026`;
    else label.textContent = `load earlier records (${size})`;
  }
  function setOlderPill(n) {
    olderRemaining = Math.max(0, n | 0);
    paintOlderPill();
  }
  function setOlderOwner(on) {
    olderOwner = !!on;
    paintOlderPill();
  }
  function paintOlderPill() {
    const pill = document.getElementById("older-pill");
    if (!pill) return;
    if (olderOwner && olderRemaining > 0) {
      pill.classList.remove("hidden");
      paintOlderLabel();
    } else {
      pill.classList.add("hidden");
    }
  }
  function setOlderBusy(stage) {
    olderBusy = stage || "";
    const pill = document.getElementById("older-pill");
    if (!pill) return;
    pill.classList.toggle("busy", !!olderBusy);
    if (olderBusy) pill.setAttribute("aria-busy", "true");
    else pill.removeAttribute("aria-busy");
    paintOlderLabel();
  }
  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }
  async function loadOlder() {
    if (paging || stream.classList.contains("loading") || !state.oldestOffset || olderRemaining <= 0) return;
    paging = true;
    setOlderBusy("fetch");
    try {
      const anchor = eventsEl.firstElementChild;
      const data = await apiFetch(`/api/history?before=${state.oldestOffset}&limit=1048576&align=turn`, { timeout: 6e4 });
      const page = data.events || [];
      if (!page.length) {
        setOlderPill(0);
        return;
      }
      setOlderBusy("render");
      await nextPaint();
      const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
      const sink = document.createElement("div");
      sink.style.display = "contents";
      const savedLastTextEl = state.lastTextEl, savedLastTextContent = state.lastTextContent;
      const savedTextSealed = state.textSealed;
      const savedThinkingEl = state.thinkingEl, savedThinkingContent = state.thinkingContent;
      const savedToolGroupEl = state.toolGroupEl;
      state.lastTextEl = null;
      state.lastTextContent = "";
      state.textSealed = false;
      state.thinkingEl = null;
      state.thinkingContent = "";
      state.toolGroupEl = null;
      pageSink = sink;
      try {
        for (const item of page) addEvent(item);
      } finally {
        pageSink = null;
        state.lastTextEl = savedLastTextEl;
        state.lastTextContent = savedLastTextContent;
        state.textSealed = savedTextSealed;
        state.thinkingEl = savedThinkingEl;
        state.thinkingContent = savedThinkingContent;
        state.toolGroupEl = savedToolGroupEl;
      }
      const mathBlocks = Array.from(sink.querySelectorAll(".event.text .body, .event.user .body")).filter(hasMathText);
      const frag = document.createDocumentFragment();
      while (sink.firstChild) frag.appendChild(sink.firstChild);
      eventsEl.insertBefore(frag, eventsEl.firstElementChild);
      eventsEl.dispatchEvent(new CustomEvent("clutch:page-prepended"));
      if (typeof MathJax !== "undefined" && typeof MathJax.typesetPromise === "function") {
        for (const b of mathBlocks) {
          try {
            await MathJax.typesetPromise([b]);
          } catch (e) {
          }
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (anchor && anchorTop !== null) {
        const onTop = anchor.getClientRects().length ? anchor : anchor.closest(".turn-fold");
        if (onTop) stream.scrollTop += onTop.getBoundingClientRect().top - anchorTop;
      }
      setOlderPill(data.older);
    } catch (e) {
      notice("Failed to load earlier records: " + e.message);
    } finally {
      paging = false;
      setOlderBusy("");
    }
  }
  $("#older-pill").addEventListener("click", loadOlder);
  document.addEventListener("clutch:project-read-only", (ev) => {
    const d = ev && ev.detail || {};
    setReadOnly(!!d.readOnly);
  });
  document.addEventListener("clutch:project-claim", (ev) => {
    const d = ev && ev.detail || {};
    setClaimed(!!d.claimed);
  });
  async function reloadActiveProject() {
    const tab = activeTab();
    if (!tab || !tab.path) return;
    currentProject = "";
    await activateTab(tab);
  }
  var claimPill = $("#claim-pill");
  if (claimPill) claimPill.addEventListener("click", () => {
    void reloadActiveProject();
  });
  function setProjectInfo(info) {
    currentProject = info.project || "";
    if (info.workdir) els.workspace.textContent = info.workdir;
    setStatus("idle");
    document.dispatchEvent(new CustomEvent("clutch:project-info", { detail: { project: currentProject, name: info.name } }));
  }
  function showWelcome() {
    supersedeOpen();
    currentProject = "";
    enterWorkspace("");
    state.apiBase = null;
    try {
      sessionStorage.removeItem("clutch_api_url");
    } catch (e) {
    }
    closeSSE();
    apply(paneWelcome());
    setReadOnly(false);
    setClaimed(false);
    setStatus("idle");
    document.dispatchEvent(new CustomEvent("clutch:project-info", { detail: { project: "", name: "" } }));
  }
  function describeHolder(owner) {
    if (!owner || typeof owner !== "object") return "";
    const bits = [];
    if (Number.isInteger(owner.pid)) bits.push(`process ${owner.pid}`);
    if (owner.host) bits.push(`on ${owner.host}`);
    if (typeof owner.since === "number" && owner.since > 0) {
      bits.push(`since ${new Date(owner.since * 1e3).toLocaleString()}`);
    }
    return bits.length ? `Held by ${bits.join(" ")}.` : "";
  }
  function dismissBlocked() {
    const state2 = currentPane();
    if (state2.view === "blocked") setPane({ ...state2, shown: false });
  }
  function showBlocked(tab, text, machine) {
    apply(paneBlocked(tab && tab.id || null, text, machine || null));
  }
  async function retryTab(tab) {
    if (!tab) return;
    dismissBlocked();
    forgetDomCache(tab.id);
    tab.unreachable = null;
    beginPaneLoad(tab);
    if (state.activeTabId === tab.id) currentProject = "";
    await activateTab(tab);
  }
  (function wireBlocked() {
    const retry = document.getElementById("tab-blocked-retry");
    if (retry) {
      retry.addEventListener("click", async () => {
        const tab = state.tabs.find((x) => x.id === paneBlockedTabId());
        if (!tab) return;
        retry.disabled = true;
        try {
          await retryTab(tab);
        } finally {
          retry.disabled = false;
        }
      });
    }
    const dismiss = document.getElementById("tab-blocked-dismiss");
    if (dismiss) dismiss.addEventListener("click", () => dismissBlocked());
  })();
  async function machineMismatch(tab) {
    if (tab.machine !== void 0) return null;
    if (!(window.clutchApi && window.clutchApi.slotStatus)) return null;
    let st;
    try {
      st = await window.clutchApi.slotStatus(tab.id);
    } catch (e) {
      return null;
    }
    if (!st || st.kind !== "local") return null;
    if (await hereHasIt(tab)) return null;
    return rememberedMachine();
  }
  async function hereHasIt(tab) {
    const dir = dirOf(tab.path);
    if (!dir) return true;
    try {
      const r = await apiFetch("/api/fs/stat?path=" + encodeURIComponent(dir), {
        base: tab.base || state.apiBase
      });
      return !(r && r.type === "none");
    } catch (e) {
      return true;
    }
  }
  function apply(next) {
    if (next.view !== "tab") clearStream();
    if (next.view === "load") stream.scrollTop = 0;
    setPane(next);
  }
  function tabLabel(tab) {
    return tab && (tab.name || (tab.path ? String(tab.path).split("/").pop() : "")) || "project";
  }
  function beginPaneLoad(tab) {
    const id = tab && tab.id || "";
    const label = tabLabel(tab);
    const where = tab && tab.machine ? `on ${machineLabel(tab.machine)}` : "";
    const now = currentPane();
    if (id && now.view === "load" && now.tabId === id) {
      if (now.label !== label || now.where !== where) setPane({ ...now, label, where });
      return;
    }
    apply(paneLoad(id, label, where));
  }
  onPaneChange((pane2) => setOlderOwner(pane2.view === "tab"));
  async function openInTab(tab, base, readOnly2 = false, seq = openSeq) {
    const path = tab.path;
    try {
      if (!base) throw noBackend();
      const ctl = new AbortController();
      openAbort = ctl;
      const r = await fetch(base + "/api/project/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, ...readOnly2 ? { read_only: true } : {} }),
        signal: ctl.signal
      });
      if (isStale(seq)) return null;
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const e = new Error(err.error || r.status);
        e.code = err.code || null;
        e.owner = err.owner || null;
        e.project = err.project || null;
        throw e;
      }
      if (isStale(seq)) return null;
      clearStream();
      paneReplayProgress("parse", 0);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let started = false;
      let processed = 0;
      let totalEvents = 0;
      let rendered = 0;
      for (; ; ) {
        const { done, value } = await reader.read();
        if (isStale(seq)) return null;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (e) {
            console.warn("[openProject] undecodable line", e);
            continue;
          }
          if (isStale(seq)) return null;
          if (msg.error) {
            const e = new Error(msg.error);
            e.code = msg.code || null;
            throw e;
          }
          if (msg.meta) {
            tab.path = msg.meta.project;
            tab.projectKey = msg.meta.project;
            if (msg.meta.name) tab.name = msg.meta.name;
            setProjectInfo({
              project: msg.meta.project,
              name: msg.meta.name,
              workdir: msg.meta.workdir
            });
            started = true;
          } else if (msg.count) {
            totalEvents = msg.count;
            if (typeof msg.older === "number") setOlderPill(msg.older);
          } else if (msg.progress && msg.progress.total) {
            paneReplayProgress("parse", msg.progress.done / msg.progress.total);
          } else if (msg.event) {
            addEvent(msg);
            if (totalEvents) paneReplayProgress("render", ++rendered / totalEvents);
          }
          if (++processed % 25 === 0) await new Promise((r2) => setTimeout(r2, 0));
        }
      }
      if (isStale(seq)) return null;
      await typesetProgressively(eventsEl, (f) => paneReplayProgress("typeset", f));
      if (isStale(seq)) return null;
      if (started) paneReplayProgress("typeset", 1);
      apply(paneTab(tab.id));
      placeRestored(tab.id);
      if (started) await noteTabMachine(tab);
      if (isStale(seq)) return null;
      finishOpen();
      return null;
    } catch (e) {
      if (isStale(seq, e)) return null;
      if (e && /not a \.clc/i.test(String(e.message || ""))) {
        const far = await machineMismatch(tab);
        if (isStale(seq)) return null;
        if (far) {
          tab.machine = far;
          const moved = await claimTab(tab);
          if (isStale(seq)) return null;
          if (moved) {
            adoptBase(moved);
            clearStream();
            return await openInTab(tab, moved, readOnly2, seq);
          }
          clearStream();
          return paneBlocked(
            tab.id,
            tab.unreachable || `${tab.name || tab.path} lives on ${machineLabel(far)}`,
            far
          );
        }
      }
      console.error("[openProject] failed:", { api: state.apiBase, path, error: e && e.message });
      return paneBlocked(
        tab.id,
        "Failed to open project: " + e.message + (tab.machine ? ` (on ${machineLabel(tab.machine)})` : ""),
        tab.machine
      );
    }
  }
  function placeRestored(tabId) {
    const placed = restoreMemento(tabId);
    if (placed === null) {
      state.followTail = true;
      stream.scrollTop = stream.scrollHeight;
      setJumpVisible(false);
      return;
    }
    state.followTail = nearBottom();
    setJumpVisible(!state.followTail);
  }
  function finishOpen() {
    reconnectSSE();
    refreshTree();
    refreshRollbackAnchors();
    resumeTurn();
  }
  var RESTORE_MAX_PAGES = 8;
  var RESTORE_PAGE_BYTES = 256 * 1024;
  async function restoreTabView(tab, base, seq) {
    const m = mementoOf(tab.id);
    if (!m || m.high === null || !tab.path) return false;
    const ctl = new AbortController();
    viewAbort = ctl;
    const signal = ctl.signal;
    let info;
    try {
      info = await apiFetch("/api/session", { base, signal });
    } catch (e) {
      return false;
    }
    if (isStale(seq)) return false;
    const openPath = info && info.memory && typeof info.memory.path === "string" ? info.memory.path : "";
    if (!openPath || openPath !== (tab.projectKey || tab.path)) return false;
    const pages = [];
    const mem = info && info.memory;
    const tail = mem && typeof mem.bytes === "number" && Number.isFinite(mem.bytes) ? mem.bytes : null;
    let cursor = tail === null ? m.high + 1 : tail;
    const target = typeof m.oldest === "number" ? m.oldest : m.high;
    const span = Math.max(1, cursor - target);
    const from = cursor;
    for (let i = 0; i < RESTORE_MAX_PAGES && cursor > target; i++) {
      let page;
      try {
        page = await apiFetch(
          `/api/history?before=${cursor}&limit=${RESTORE_PAGE_BYTES}&align=turn`,
          { base, signal }
        );
      } catch (e) {
        break;
      }
      if (isStale(seq)) return false;
      const events = page && Array.isArray(page.events) ? page.events : [];
      if (!events.length) break;
      pages.push(events);
      const older = Number.isFinite(page.older) ? page.older : 0;
      if (older >= cursor) break;
      cursor = older;
      paneReplayProgress("parse", Math.min(1, (from - cursor) / span));
    }
    if (!pages.length) return false;
    const project = tab.projectKey || tab.path;
    clearStream();
    setProjectInfo({
      project,
      name: tab.name || project.split("/").pop() || project,
      workdir: m.workdir || dirOf(project)
    });
    const total = pages.reduce((n, p) => n + p.length, 0);
    let painted = 0;
    for (let i = pages.length - 1; i >= 0; i--) {
      for (const item of pages[i]) {
        if (isStale(seq)) return true;
        addEvent(item);
        if (total) paneReplayProgress("render", ++painted / total);
        if (painted % 25 === 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (isStale(seq)) return true;
        }
      }
    }
    setOlderPill(Math.max(0, cursor));
    await typesetProgressively(eventsEl, (f) => paneReplayProgress("typeset", f));
    if (isStale(seq)) return true;
    placeRestored(tab.id);
    paneReplayProgress("typeset", 1);
    finishOpen();
    return true;
  }
  function paintCachedView(tab) {
    if (!tab || !tab.id || !tab.path) return false;
    if (tab.machine && !hopUpFor(tab)) return false;
    if (!restoreDomCache(tab.id)) return false;
    state.followTail = nearBottom();
    setJumpVisible(!state.followTail);
    dropOrphanLive();
    const m = mementoOf(tab.id);
    const projectPath = tab.projectKey || tab.path;
    setProjectInfo({
      project: projectPath,
      name: tab.name || projectPath.split("/").pop() || projectPath,
      workdir: m && m.workdir || dirOf(projectPath)
    });
    if (m) setOlderPill(m.older);
    return true;
  }
  async function activateTab(tab, readOnly2 = false) {
    if (!tab) return;
    const same = tab.id === state.activeTabId;
    if (same && opening && opening.id === tab.id) {
      await opening.promise;
      return;
    }
    const here = tab.projectKey || tab.path;
    if (same && !opening && currentProject && currentProject === here) return;
    const prev = activeTab();
    if (prev && prev.id !== tab.id) {
      settleCatchUp();
      saveMemento(prev.id, { older: olderRemaining, workdir: els.workspace.textContent || "" });
      if (paneBlockedTabId() === prev.id) {
        forgetDomCache(prev.id);
        dismissBlocked();
      } else {
        saveDomCache(prev.id);
      }
      if (prev.running) watchTab(prev);
    }
    const seq = supersedeOpen();
    closeSSE();
    endSend();
    const changed = state.activeTabId !== tab.id;
    state.activeTabId = tab.id;
    if (changed) document.dispatchEvent(new CustomEvent("clutch:tab-state"));
    unwatchTab(tab.id);
    tab.needsInput = false;
    const cached = paintCachedView(tab);
    if (!cached) beginPaneLoad(tab);
    const projectHere = tab.projectKey || tab.path || "";
    const hereMemo = mementoOf(tab.id);
    enterWorkspace(projectHere, hereMemo && hereMemo.workdir || dirOf(projectHere));
    const run2 = async () => {
      const base = await claimTab(tab);
      if (isStale(seq)) return null;
      if (!base) {
        return paneBlocked(
          tab.id,
          tab.unreachable || "This tab has no session \u2014 the backend is not running.",
          tab.unreachable ? tab.machine || null : null
        );
      }
      tab.unreachable = null;
      adoptBase(base);
      refreshTree();
      if (!tab.path) return paneTab(tab.id);
      if (cached) {
        finishOpen();
        return paneTab(tab.id);
      }
      if (await restoreTabView(tab, base, seq)) return isStale(seq) ? null : paneTab(tab.id);
      if (isStale(seq)) return null;
      return await openInTab(tab, base, readOnly2, seq);
    };
    const mine = { id: tab.id, promise: run2() };
    opening = mine;
    let next = null;
    try {
      next = await run2();
    } finally {
      if (opening === mine) opening = null;
    }
    if (next && !isStale(seq)) apply(next);
  }
  async function openProject(path, readOnly2 = false) {
    const existing = findTabByPath(path);
    if (existing && existing.id === state.activeTabId && currentProject === path) return;
    const tab = existing || ensureTab(path);
    await activateTab(tab, readOnly2);
  }
  async function createProject(dir, name) {
    const prev = activeTab();
    if (prev) {
      saveMemento(prev.id, { older: olderRemaining, workdir: els.workspace.textContent || "" });
      saveDomCache(prev.id);
      if (prev.running) watchTab(prev);
    }
    const seq = supersedeOpen();
    closeSSE();
    const tab = ensureTab("", name);
    state.activeTabId = tab.id;
    document.dispatchEvent(new CustomEvent("clutch:tab-state"));
    beginPaneLoad(tab);
    const base = await claimTab(tab);
    if (isStale(seq)) return;
    if (!base) {
      showBlocked(
        tab,
        tab.unreachable || "Could not start a session for the new project \u2014 the backend is not running.",
        tab.unreachable ? tab.machine || null : null
      );
      return;
    }
    adoptBase(base);
    try {
      const data = await apiFetch("/api/project/new", { method: "POST", body: { dir, name } });
      if (isStale(seq)) return;
      tab.path = data.project;
      tab.projectKey = data.project;
      if (data.name) tab.name = data.name;
      clearStream();
      setProjectInfo(data);
      apply(paneTab(tab.id));
      finishOpen();
    } catch (e) {
      if (isStale(seq)) return;
      const held = e && e.code === "project_open_conflict" ? describeHolder(e.owner) : "";
      const why = "Failed to create project: " + e.message + (held ? " \u2014 " + held : "");
      if (!tab.path) {
        const i = state.tabs.indexOf(tab);
        if (i >= 0) state.tabs.splice(i, 1);
        if (state.activeTabId === tab.id) state.activeTabId = null;
        await releaseTab(tab);
        document.dispatchEvent(new CustomEvent("clutch:tab-state"));
      }
      showBlocked(tab, why);
      if (!state.tabs.length) showWelcome();
    }
  }

  // src/renderer/auto-fold.ts
  function foldLabel(n) {
    return `process \xB7 ${n} ${n === 1 ? "step" : "steps"}`;
  }
  function turnEnded(status) {
    const s = String(status || "").trim();
    return s === "completed" || s === "aborted" || s === "released";
  }
  function turnSpan(kids, turnEnd) {
    let span = 0;
    for (let i = turnEnd - 1; i >= 0; i--) {
      if (kids[i].matches(".completion")) {
        span = i + 1;
        break;
      }
    }
    while (span > 0) {
      const above = kids[span - 1];
      if (!above.matches(".completion") || turnEnded(above.textContent)) break;
      let from = 0;
      for (let i = span - 2; i >= 0; i--) {
        if (kids[i].matches(".completion")) {
          from = i + 1;
          break;
        }
      }
      span = from;
    }
    return span;
  }
  function openFoldAt(kids, from, to) {
    for (let i = from; i < to; i++) {
      if (kids[i].matches(".turn-fold") && kids[i].dataset.turnOpen === "1") return i;
    }
    return -1;
  }
  function turnHead(kids, span, to) {
    for (let i = span; i < to; i++) {
      if (kids[i].matches(".event.user")) return i;
      if (kids[i].matches(".completion") || kids[i].matches(".turn-fold")) break;
    }
    return span === 0 ? 0 : -1;
  }
  function segmentFrom(kids, head, at) {
    for (let i = at - 1; i > head; i--) {
      if (holdsTheLine(kids[i])) return i + 1;
    }
    return head + 1;
  }
  function buildFold(root, ref, rows) {
    const wrap = document.createElement("div");
    wrap.className = "turn-fold";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "turn-fold-head";
    head.setAttribute("aria-expanded", "false");
    const caret = document.createElement("span");
    caret.className = "turn-fold-caret";
    caret.textContent = "\u25B6";
    const label = document.createElement("span");
    label.textContent = foldLabel(rows.length);
    const spin = document.createElement("span");
    spin.className = "turn-fold-spin";
    spin.setAttribute("aria-hidden", "true");
    head.appendChild(caret);
    head.appendChild(label);
    head.appendChild(spin);
    const fold = document.createElement("div");
    fold.className = "fold open";
    const inner = document.createElement("div");
    inner.className = "fold-inner";
    const body = document.createElement("div");
    body.className = "fold-body";
    inner.appendChild(body);
    fold.appendChild(inner);
    wrap.appendChild(head);
    wrap.appendChild(fold);
    root.insertBefore(wrap, ref);
    const frag = document.createDocumentFragment();
    for (const el of rows) frag.appendChild(el);
    body.appendChild(frag);
    wrap._body = body;
    wrap._label = label;
    wrap._head = head;
    wrap._fold = fold;
    head.onclick = () => {
      const open = toggleFold(fold);
      head.setAttribute("aria-expanded", open ? "true" : "false");
      wrap._touched = true;
    };
    return wrap;
  }
  function foldRegion(root, turnEnd) {
    const kids = Array.from(root.children);
    const divider = kids[turnEnd] && kids[turnEnd].matches(".completion") ? kids[turnEnd] : null;
    const span = turnSpan(kids, turnEnd);
    const openAt = openFoldAt(kids, span, turnEnd);
    const start = turnHead(kids, span, turnEnd);
    const opener = start >= 0 ? kids[start] : null;
    const claimed2 = openAt >= 0 || !!(divider && divider.dataset.turnFolded === "1");
    if (!claimed2) {
      if (!opener) return;
      if (opener.dataset.turnFolded === "1") return;
    }
    const from = opener ? start + 1 : openAt >= 0 ? openAt : span;
    mergeOpenFold(root, from, turnEnd, divider, opener);
  }
  function mergeOpenFold(root, from, turnEnd, divider, headRow) {
    const wrap = foldSegmentRows(root, from, turnEnd, !foldsLandClosed());
    if (headRow) {
      if (wrap) headRow.dataset.turnFolded = "1";
      else delete headRow.dataset.turnFolded;
    }
    if (wrap && divider) divider.dataset.turnFolded = "1";
    setTurnOpen(root, wrap && !turnEnded(divider ? divider.textContent : "") ? wrap : null);
    queueStuck();
  }
  function foldSegmentRows(root, from, to, animate) {
    const rows = Array.from(root.children).slice(from, to);
    const segs = [];
    let seg = [];
    for (const el of rows) {
      if (!holdsTheLine(el)) {
        seg.push(el);
        continue;
      }
      if (seg.length) segs.push(seg);
      seg = [];
    }
    if (seg.length) segs.push(seg);
    let newest = null;
    for (const loose of segs) {
      const mid = loose.filter((el) => !el.matches(".live"));
      if (!mid.length) continue;
      const at = mid.findIndex((el) => el.matches(".turn-fold"));
      if (at < 0) {
        const made = buildFold(root, mid[0], mid);
        if (animate) foldCollapse(made._fold);
        else closeBlock(made);
        for (const el of mid) delete el.dataset.turnFolded;
        newest = made;
        continue;
      }
      const wrap = mid[at];
      const above = mid.slice(0, at);
      const below = mid.slice(at + 1);
      if (above.length) root.insertBefore(wrap, above[0]);
      absorbInto(root, wrap, above, true);
      absorbInto(root, wrap, below, false);
      newest = wrap;
    }
    return newest;
  }
  function absorbInto(root, wrap, rows, atTop) {
    let reader = false;
    for (const el of atTop ? rows.slice().reverse() : rows) {
      if (!el || el.parentNode !== root) continue;
      if (el.matches(".live")) continue;
      if (atTop) wrap._body.insertBefore(el, wrap._body.children[0] || null);
      else wrap._body.appendChild(el);
      delete el.dataset.turnFolded;
      if (el.matches(".event.user")) reader = true;
    }
    if (wrap._label) wrap._label.textContent = foldLabel(wrap._body.children.length);
    queueStuck();
    return reader;
  }
  function autoFoldTurn() {
    if (pageSink) return;
    if (!eventsEl) return;
    const kids = Array.from(eventsEl.children);
    let turnEnd = kids.length;
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i].matches(".completion")) {
        turnEnd = i;
        break;
      }
    }
    foldRegion(eventsEl, turnEnd);
    settleRunBlocks();
  }
  function foldOpenTurn() {
    if (pageSink) return;
    if (!eventsEl) return;
    const kids = Array.from(eventsEl.children);
    if (!kids.length || kids[kids.length - 1].matches(".completion")) return;
    foldRegion(eventsEl, kids.length);
  }
  function runInFlight() {
    return !!busy && !catchUp && !paging && !pageSink && !stream.classList.contains("loading");
  }
  function runProcessRow(el) {
    if (!el.matches(".event")) return false;
    if (el.matches(".event.user") || el.matches(".event.text") || el.matches(".live")) return false;
    return true;
  }
  function holdsTheLine(el) {
    return el.matches(".event.text");
  }
  function foldLiveRow(el) {
    if (!eventsEl || !el) return;
    if (el.dataset && el.dataset.restored) {
      delete el.dataset.restored;
      return;
    }
    if (!runInFlight()) return;
    if (el.parentNode !== eventsEl) return;
    if (el.matches(".event.text")) {
      settleRunBlocks();
      return;
    }
    if (!runProcessRow(el)) return;
    const wrap = openRunBlock(el);
    if (!wrap) return;
    takeIntoBlock(wrap, el);
    autoScroll();
  }
  function openRunBlock(el) {
    const kids = Array.from(eventsEl.children);
    const at = kids.indexOf(el);
    if (at < 0) return null;
    for (let i = at - 1; i >= 0; i--) {
      if (kids[i].matches(".event.user")) break;
      if (!kids[i].matches(".completion")) continue;
      if (turnEnded(kids[i].textContent)) return null;
      break;
    }
    const span = turnSpan(kids, kids.length);
    const head = turnHead(kids, span, at);
    if (head < 0 || at <= head) return null;
    const from = segmentFrom(kids, head, at);
    const rows = kids.slice(from, at);
    const open = rows.findIndex((row) => row.matches(".turn-fold"));
    if (open >= 0) {
      const wrap2 = rows[open];
      const above = rows.slice(0, open).filter((row) => !row.matches(".live"));
      const below = rows.slice(open + 1).filter((row) => !row.matches(".live"));
      if (above.length) eventsEl.insertBefore(wrap2, above[0]);
      const aboveReader = absorbInto(eventsEl, wrap2, above, true);
      const belowReader = absorbInto(eventsEl, wrap2, below, false);
      markLive(wrap2);
      if (aboveReader || belowReader) openBlock(wrap2);
      return wrap2;
    }
    const mid = kids.slice(from, at + 1).filter((row) => !row.matches(".live"));
    if (!mid.length) return null;
    for (const row of mid) delete row.dataset.turnFolded;
    const wrap = buildFold(eventsEl, mid[0], mid);
    closeBlock(wrap);
    markLive(wrap);
    if (mid.some((row) => row.matches(".event.user"))) openBlock(wrap);
    return wrap;
  }
  function closeBlock(wrap) {
    if (!wrap._fold) return;
    wrap._fold.classList.remove("open");
    wrap._fold.classList.add("hidden");
    if (wrap._head) wrap._head.setAttribute("aria-expanded", "false");
  }
  function openBlock(wrap) {
    if (!wrap._fold) return;
    wrap._fold.classList.remove("hidden");
    wrap._fold.classList.add("open");
    if (wrap._head) wrap._head.setAttribute("aria-expanded", "true");
  }
  function markLive(wrap) {
    setTurnOpen(wrap.parentNode || eventsEl, wrap);
    if (wrap.dataset.turnLive === "1") return;
    wrap.dataset.turnLive = "1";
    wrap.setAttribute("aria-busy", "true");
    if (!wrap._fold || !wrap._fold.classList.contains("open")) return;
    wrap._head.setAttribute("aria-expanded", "true");
  }
  function setTurnOpen(root, wrap) {
    for (const el of Array.from(root.children)) {
      if (el.matches(".turn-fold") && el !== wrap) delete el.dataset.turnOpen;
    }
    if (wrap) wrap.dataset.turnOpen = "1";
  }
  function takeIntoBlock(wrap, el) {
    wrap._body.appendChild(el);
    if (wrap._label) wrap._label.textContent = foldLabel(wrap._body.children.length);
    queueStuck();
  }
  function liveBlocks() {
    if (!eventsEl) return [];
    return Array.from(eventsEl.children).filter((el) => el.matches(".turn-fold") && el.dataset.turnLive === "1");
  }
  function settleRunBlocks() {
    for (const wrap of liveBlocks()) {
      delete wrap.dataset.turnLive;
      wrap.setAttribute("aria-busy", "false");
      if (wrap._touched) continue;
      const fold = wrap._fold;
      if (!fold || fold.classList.contains("hidden")) continue;
      if (foldsLandClosed()) {
        fold.classList.remove("open");
        fold.classList.add("hidden");
      } else {
        foldCollapse(fold);
      }
      if (wrap._head) wrap._head.setAttribute("aria-expanded", "false");
    }
  }
  function clearRunLive() {
    for (const wrap of liveBlocks()) {
      delete wrap.dataset.turnLive;
      wrap.setAttribute("aria-busy", "false");
    }
  }
  function watchLiveRows() {
    if (!eventsEl || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.target !== eventsEl) continue;
        for (const node of rec.addedNodes) {
          if (node && node.nodeType === 1) foldLiveRow(node);
        }
      }
    });
    mo.observe(eventsEl, { childList: true });
  }
  function foldClosedRegions(root) {
    if (!root) return;
    const ends = Array.from(root.children).filter((el) => el.matches(".completion"));
    for (const divider of ends) {
      const at = Array.from(root.children).indexOf(divider);
      if (at >= 0) foldRegion(root, at);
    }
  }
  function foldsLandClosed() {
    return stream.classList.contains("loading") || paging;
  }
  if (eventsEl) eventsEl.addEventListener("clutch:page-prepended", () => foldClosedRegions(eventsEl));
  if (eventsEl) eventsEl.addEventListener("clutch:turn-interrupted", () => {
    clearRunLive();
    foldOpenTurn();
  });
  if (eventsEl) watchLiveRows();

  // src/renderer/stream-events.ts
  var streamRows = {};
  function handleToolCallDelta(ev) {
    let st = streamRows[ev.tool_call_id];
    if (!st) {
      if (!ev.name) return;
      const ui = uiOf(ev);
      const group = toolGroupFor(ev.tool_call_id, ui);
      st = streamRows[ev.tool_call_id] = { name: ev.name, ui, text: "", row: null, body: null, group };
      st.row = makeToolRowBase(ui, ev.name);
      st.row.classList.add("stream");
      if (ui.preview === "none" || ui.preview && ui.preview.mode === "none") {
        const dots = document.createElement("span");
        dots.className = "muted";
        dots.textContent = "\u2026";
        st.row.appendChild(dots);
      } else {
        st.body = document.createElement("pre");
        st.body.className = "tool-args-detail stream-pre";
        st.row.appendChild(st.body);
      }
      group.el.appendChild(st.row);
      autoScroll();
    }
    st.text += ev.delta;
    if (st.body) st.body.textContent = previewText(st.ui, st.name, st.text);
    autoScroll();
  }
  function clearStreamPreviews() {
    for (const id of Object.keys(streamRows)) {
      if (streamRows[id]) streamRows[id].row.remove();
      delete streamRows[id];
    }
  }
  function discardLivePartial() {
    if (state.textRenderRaf) {
      cancelAnimationFrame(state.textRenderRaf);
      state.textRenderRaf = 0;
    }
    if (state.lastTextEl) {
      unawait(state.lastTextEl);
      state.lastTextEl.remove();
      state.lastTextEl = null;
    }
    state.lastTextContent = "";
    state.textSealed = false;
    dropScaffold();
  }
  function dropScaffold() {
    if (state.thinkingRenderRaf) {
      cancelAnimationFrame(state.thinkingRenderRaf);
      state.thinkingRenderRaf = 0;
    }
    if (state.thinkingEl) {
      state.thinkingEl.remove();
      state.thinkingEl = null;
    }
    state.thinkingContent = "";
    clearStreamPreviews();
  }
  function dropOrphanLive() {
    const live = state.lastTextEl && state.lastTextEl.isConnected ? state.lastTextEl : null;
    if (live && state.lastTextContent) {
      const owed = !(state.textSealed || state.runSettled);
      flushTextRender();
      state.textSealed = true;
      if (owed) awaitRecord(live, state.lastTextContent);
      dropScaffold();
    } else {
      discardLivePartial();
    }
    state.toolGroupEl = null;
    clearRetryNote();
  }
  var awaiting = [];
  function awaitRecord(el, text) {
    if (!awaiting.some((w) => w.el === el)) awaiting.push({ el, text });
  }
  function unawait(el) {
    const i = awaiting.findIndex((w) => w.el === el);
    if (i >= 0) awaiting.splice(i, 1);
  }
  function awaitingFor(text) {
    if (!text) return null;
    for (let i = awaiting.length - 1; i >= 0; i--) {
      if (!awaiting[i].el.isConnected) awaiting.splice(i, 1);
    }
    for (let i = awaiting.length - 1; i >= 0; i--) {
      const w = awaiting[i];
      if (w.text && text.startsWith(w.text)) return w;
    }
    return null;
  }
  function completeRecord(el, text) {
    paintTextBlock(el, text, true);
    unawait(el);
    if (state.lastTextEl !== el) return;
    state.lastTextContent = text;
    state.textSealed = true;
  }
  function rememberRecord(el, text) {
    if (pageSink || !text) return;
    state.lastRecordEl = el;
    state.lastRecordText = text;
  }
  function setRetryNote(ev) {
    if (state.retryNoteEl) state.retryNoteEl.remove();
    state.retryNoteEl = document.createElement("div");
    state.retryNoteEl.className = "event llm-note live";
    const p = document.createElement("p");
    p.className = "body";
    const fallback = `connection lost \u2014 retrying (${ev.attempt}/${ev.max_retries || "\u2026"})`;
    p.textContent = "\u26A0 " + (ev.message || fallback);
    state.retryNoteEl.appendChild(p);
    (pageSink || eventsEl).appendChild(state.retryNoteEl);
    autoScroll();
  }
  function clearRetryNote() {
    if (state.retryNoteEl) {
      state.retryNoteEl.remove();
      state.retryNoteEl = null;
    }
  }
  function announceRunLost() {
    state.sseRunLostPending = false;
    if (state.runSettled) return;
    addEvent({ type: "final", status: "error", summary: SSE_RUN_LOST });
  }
  function settleCatchUp() {
    while (state.owedRecords.length) {
      const row = state.owedRecords.shift();
      if (row) row();
    }
    endCatchUp();
  }
  function addEvent(ev) {
    let wireOffset = null;
    if (ev && typeof ev === "object" && ev.event && typeof ev.offset === "number") {
      wireOffset = ev.offset;
      if (!pageSink) {
        if (state.streamHighOffset !== null && ev.offset <= state.streamHighOffset) return;
        state.streamHighOffset = Math.max(state.streamHighOffset === null ? 0 : state.streamHighOffset, ev.offset);
      }
      if (ev.offset > 0) state.oldestOffset = state.oldestOffset === null ? ev.offset : Math.min(state.oldestOffset, ev.offset);
      ev = ev.event;
    }
    if (ev && ev.type === "user_message") {
      if (state.sseRunLostPending) announceRunLost();
      state.runSettled = false;
      if (state.textSealed) {
        state.lastTextEl = null;
        state.lastTextContent = "";
        state.textSealed = false;
      }
      state.lastRecordEl = null;
      state.lastRecordText = "";
      awaiting.length = 0;
      forgetAnsweredPerm();
      noteUserMessage(ev.content);
    } else if (ev && ev.type === "final") {
      state.runSettled = true;
    }
    if (ev && ev.type === "history") {
      settleCatchUp();
      setOlderPill(ev.older || 0);
      beginCatchUp();
      return;
    }
    if (ev && ev.type === "replayed") {
      settleCatchUp();
      refreshTree();
      if (state.sseRunLostPending) announceRunLost();
      return;
    }
    if (ev && ev.type === "resync") {
      clearStream();
      return;
    }
    if (stream.classList.contains("loading") && ev.type === "state_update") {
      return;
    }
    const paint = () => {
      if (ev && ev.type !== "text_delta") flushTextRender();
      if (ev && ev.type !== "reasoning_delta") flushThinkingRender();
      if (["user_message", "text_delta", "reasoning_delta", "final", "step_start"].includes(ev.type)) {
        state.toolGroupEl = null;
      }
      if (applyStreamEvent(ev)) return;
      const el = renderEvent(ev);
      if (el) {
        if (wireOffset !== null && !pageSink) el.dataset.offset = String(wireOffset);
        (pageSink || eventsEl).appendChild(el);
        if (el.matches(".event.user")) highlightCode(el);
        if (el.matches(".event.user") && !pageSink) typesetMath(el);
        autoScroll();
      }
    };
    if (catchUp && !pageSink) {
      state.owedRecords.push(paint);
      return;
    }
    paint();
  }
  function applyStreamEvent(ev) {
    if (ev.type === "compaction_delta") {
      if (ev.done) {
        if (state.compactionEl) {
          state.compactionEl.remove();
          state.compactionEl = null;
        }
        clearRetryNote();
        return true;
      }
      if (!state.compactionEl) {
        state.compactionEl = document.createElement("div");
        state.compactionEl.className = "event compaction live";
        state.compactionEl.innerHTML = '<div class="hdr">compressing context</div>';
        const p = document.createElement("p");
        p.className = "body muted";
        state.compactionEl.appendChild(p);
        (pageSink || eventsEl).appendChild(state.compactionEl);
      }
      state.compactionEl.querySelector("p").textContent = ev.note ? ev.note : ev.chars > 0 ? `summarizing earlier turns\u2026 ${ev.chars} chars streamed` : "compressing context \u2014 rolling earlier turns into a summary\u2026";
      autoScroll();
      return true;
    }
    if (ev.type === "llm_retry") {
      if (ev.discard) discardLivePartial();
      setRetryNote(ev);
      return true;
    }
    if (ev.type === "compaction") {
      if (state.compactionEl) {
        state.compactionEl.remove();
        state.compactionEl = null;
      }
      const el = document.createElement("div");
      el.className = "event compaction";
      el.innerHTML = '<div class="hdr">context compressed</div>';
      const p = document.createElement("p");
      p.className = "body muted";
      const summary = (ev.summary || "").trim();
      p.textContent = summary ? "Earlier turns were rolled into a " + summary.length + "-char summary to fit the context window." : "The conversation was compacted to fit the context window.";
      el.appendChild(p);
      (pageSink || eventsEl).appendChild(el);
      autoScroll();
      return true;
    }
    if (ev.type === "assistant_message") {
      state.toolGroupEl = null;
      const live = state.lastTextEl && state.lastTextEl.isConnected ? state.lastTextEl : null;
      if (live && ev.content && ev.content.startsWith(state.lastTextContent || "")) {
        completeRecord(live, ev.content);
        rememberRecord(live, ev.content);
        return true;
      }
      const owed = awaitingFor(ev.content);
      if (owed) {
        completeRecord(owed.el, ev.content);
        rememberRecord(owed.el, ev.content);
        autoScroll();
        return true;
      }
      if (ev.reasoning && !(state.thinkingEl && state.thinkingEl.isConnected)) appendThinkingRow(ev.reasoning);
      if (ev.content) {
        const wrap = createAgentTextBlock();
        wrap.querySelector(".body").innerHTML = renderMarkdown(ev.content);
        highlightCode(wrap);
        if (live) eventsEl.insertBefore(wrap, live);
        else (pageSink || eventsEl).appendChild(wrap);
        if (!pageSink) typesetMath(wrap);
        rememberRecord(wrap, ev.content);
      }
      return true;
    }
    if (ev.type === "final") {
      if (pendingPerm) closePerm();
      forgetAnsweredPerm();
      clearStreamPreviews();
      clearRetryNote();
      if (!pageSink && !catchUp && ev.status === "completed" && String(ev.summary || "").trim()) {
        const want = String(ev.summary || "");
        const live = state.lastTextEl && state.lastTextEl.isConnected ? state.lastTextEl : null;
        if (live && want.startsWith(state.lastTextContent || "")) {
          completeRecord(live, want);
          rememberRecord(live, want);
        } else {
          const owed = awaitingFor(want);
          const recorded = state.lastRecordEl && state.lastRecordEl.isConnected && state.lastRecordText && want.startsWith(state.lastRecordText) ? state.lastRecordEl : null;
          if (owed) {
            completeRecord(owed.el, want);
            autoScroll();
          } else if (recorded) {
            state.lastTextEl = recorded;
            completeRecord(recorded, want);
            rememberRecord(recorded, want);
            autoScroll();
          } else {
            const wrap = createAgentTextBlock();
            (pageSink || eventsEl).appendChild(wrap);
            state.lastTextEl = wrap;
            completeRecord(wrap, want);
            rememberRecord(wrap, want);
            autoScroll();
          }
        }
      }
      if (state.lastTextEl && state.lastTextEl.isConnected) highlightCode(state.lastTextEl);
      appendCompletion(ev.status, ev.summary);
      refreshTree();
      autoFoldTurn();
      if (!pageSink) refreshRollbackAnchors();
      return true;
    }
    if (ev.type === "tool_call" && ev.tool_call_id) {
      let args = {};
      try {
        args = JSON.parse(ev.arguments || "{}");
      } catch (e) {
        console.warn("[tool] arguments are not JSON", e);
      }
      toolCalls[ev.tool_call_id] = { name: ev.name, args, ui: ev.ui || {} };
      const st = streamRows[ev.tool_call_id];
      if (st) {
        st.row.classList.remove("stream");
        const preview = st.row.querySelector(".stream-pre");
        if (preview) preview.remove();
        const dots = st.row.querySelector(".muted");
        if (dots) dots.remove();
        st.row.appendChild(argsButton(ev.arguments, uiOf(ev)));
        st.body = null;
        streamRows[ev.tool_call_id] = void 0;
        autoScroll();
      } else {
        addToolCallRow(ev);
      }
      return true;
    }
    if (ev.type === "tool_call_delta" && ev.tool_call_id) {
      clearRetryNote();
      handleToolCallDelta(ev);
      return true;
    }
    if (ev.type === "tool_result" && toolCalls[ev.tool_call_id]) {
      const call = toolCalls[ev.tool_call_id];
      const ui = uiOfResult(ev);
      const group = ui.group ? toolCallGroups.get(ev.tool_call_id) : null;
      if (group && ui.form === "row") {
        appendResultRow(group, ui, call, ev);
        group.closed = true;
        return true;
      }
    }
    if (ev.type === "text_delta" && ev.content) {
      clearRetryNote();
      if (state.textSealed) return true;
      if (!state.lastTextEl) {
        state.lastTextEl = createAgentTextBlock();
        (pageSink || eventsEl).appendChild(state.lastTextEl);
      }
      state.lastTextContent += ev.content;
      scheduleTextRender();
      return true;
    }
    if (ev.type === "reasoning_delta" && ev.content) {
      clearRetryNote();
      state.thinkingContent += ev.content;
      if (!state.thinkingEl) {
        const block = buildThinkingBlock("", "");
        state.thinkingEl = block.el;
        (pageSink || eventsEl).appendChild(state.thinkingEl);
      }
      scheduleThinkingRender();
      return true;
    }
    if (ev.type === "step_start") {
      state.lastTextEl = null;
      state.lastTextContent = "";
      state.textSealed = false;
      state.thinkingEl = null;
      state.thinkingContent = "";
      clearRetryNote();
    }
    return false;
  }

  // src/renderer/settings.ts
  var TASK_BASE_H = els.task.offsetHeight;
  function autoGrowTask() {
    const was = els.task.style.height;
    if (!els.task.value.trim()) {
      els.task.style.height = TASK_BASE_H + "px";
    } else {
      els.task.style.height = "auto";
      els.task.style.height = Math.min(els.task.scrollHeight, Math.round(window.innerHeight * 0.3)) + "px";
    }
    if (was !== els.task.style.height) {
      state.suppressLatchUntil = performance.now() + 120;
      if (state.followTail && !nearBottom()) autoScroll();
    }
  }
  els.task.addEventListener("input", autoGrowTask);
  function customSelect(root) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cselect-btn";
    if (root.getAttribute("title")) btn.title = root.getAttribute("title");
    const valueEl = document.createElement("span");
    valueEl.className = "cselect-value";
    const markEl = document.createElement("span");
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
    document.body.appendChild(pop);
    if (root.parentNode && root.parentNode.classList && root.parentNode.classList.contains("modal-box")) pop.classList.add("cselect-pop-field");
    const GAP = 4, EDGE = 8, MAX_H = 240, MIN_H = 72, MIN_W = 120, MAX_W = 460;
    const opts = [];
    let selected = null;
    const listeners3 = [];
    const isOpen = () => root.classList.contains("open");
    const onScreen = (r) => r.bottom > 0 && r.top < window.innerHeight;
    function place() {
      const r = btn.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const room = Math.max(MIN_W, vw - 2 * EDGE);
      pop.style.maxWidth = Math.min(MAX_W, room) + "px";
      pop.style.minWidth = Math.min(r.width, room) + "px";
      pop.style.maxHeight = "none";
      const want = Math.min(pop.scrollHeight || 0, MAX_H);
      const below = vh - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const up = want > below && above > below;
      pop.style.maxHeight = Math.max(MIN_H, Math.min(MAX_H, up ? above : below)) + "px";
      const w = pop.offsetWidth || r.width;
      pop.style.left = Math.min(Math.max(EDGE, r.left), Math.max(EDGE, vw - EDGE - w)) + "px";
      if (up) {
        pop.style.top = "auto";
        pop.style.bottom = vh - r.top + GAP + "px";
      } else {
        pop.style.top = r.bottom + GAP + "px";
        pop.style.bottom = "auto";
      }
    }
    function open() {
      if (isOpen() || root.classList.contains("disabled")) return;
      if (!onScreen(btn.getBoundingClientRect())) return;
      root.classList.add("open");
      pop.classList.add("open");
      pop.style.visibility = "hidden";
      place();
      pop.style.visibility = "";
    }
    function close() {
      root.classList.remove("open");
      pop.classList.remove("open");
    }
    function render2() {
      const o = opts.find((x) => x.value === selected);
      valueEl.textContent = o ? o.text : "";
      markEl.textContent = o && o.mark || "";
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
          row.appendChild(mark);
        }
        row.addEventListener("click", () => {
          const changed = opt.value !== selected;
          selected = opt.value;
          render2();
          close();
          if (changed) for (const fn of listeners3) fn();
        });
        pop.appendChild(row);
      }
      if (isOpen()) place();
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isOpen()) close();
      else open();
    });
    document.addEventListener("click", (e) => {
      if (!root.contains(e.target) && !pop.contains(e.target)) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    function follow(e) {
      if (!isOpen()) return;
      if (e && e.target && pop.contains(e.target)) return;
      const r = btn.getBoundingClientRect();
      if (onScreen(r)) place();
      else close();
    }
    window.addEventListener("resize", follow);
    document.addEventListener("scroll", follow, true);
    return {
      set innerHTML(_v) {
        opts.length = 0;
        selected = null;
        render2();
      },
      // only ever cleared
      appendChild(opt) {
        opts.push({ value: opt.value, text: opt.textContent, mark: opt.mark || "" });
        render2();
      },
      get value() {
        return selected || "";
      },
      set value(v) {
        selected = v;
        render2();
      },
      get disabled() {
        return root.classList.contains("disabled");
      },
      set disabled(b) {
        root.classList.toggle("disabled", !!b);
      },
      addEventListener(_ev, fn) {
        listeners3.push(fn);
      },
      focus() {
        btn.focus();
      }
    };
  }
  var modal = $("#settings-modal");
  var keyInput = $("#api-key-input");
  var modelInput = $("#model-input");
  var reasoningEffortInput = customSelect($("#reasoning-effort-input"));
  for (const [v, t] of [["", "default"], ["low", "low"], ["medium", "medium"], ["max", "max"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    reasoningEffortInput.appendChild(o);
  }
  reasoningEffortInput.value = "";
  var apiProtocolInput = customSelect($("#api-protocol-input"));
  for (const [v, t] of [["", "chat completions (default)"], ["responses", "responses API"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    apiProtocolInput.appendChild(o);
  }
  apiProtocolInput.value = "";
  function setApiProtocol(v) {
    apiProtocolInput.value = v === "chat" ? "" : v || "";
  }
  var llmUrlInput = $("#llm-url-input");
  var profileSelect = customSelect($("#llm-profile-select"));
  var PROFILES_KEY = "clutch_llm_profiles";
  function llmProfiles() {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (raw === null) return {};
    let map;
    try {
      map = JSON.parse(raw);
      if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("it is not a map of profiles");
    } catch (e) {
      corruptRecord("saved LLM profiles", PROFILES_KEY, e);
      return {};
    }
    return map;
  }
  function saveLlmProfiles(profiles) {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  }
  function renderLlmProfiles(activeName) {
    const profiles = llmProfiles();
    profileSelect.innerHTML = "";
    const names = Object.keys(profiles).sort();
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (name === activeName) opt.mark = "\u2713";
      profileSelect.appendChild(opt);
    }
    profileSelect.disabled = names.length === 0;
    profileSelect.value = names.includes(activeName) ? activeName : names[0] || "";
    $("#llm-profile-del").disabled = !profileSelect.value;
    $("#llm-profile-edit").disabled = !profileSelect.value;
  }
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
  var profileNameInput = $("#llm-profile-name");
  function saveProfileAs(name, oldName) {
    const profiles = llmProfiles();
    if (oldName && oldName !== name) delete profiles[oldName];
    profiles[name] = {
      base_url: llmUrlInput.value.trim(),
      model: modelInput.value.trim(),
      api_key: keyInput.value.trim(),
      reasoning_effort: reasoningEffortInput.value.trim(),
      api_protocol: apiProtocolInput.value.trim()
    };
    saveLlmProfiles(profiles);
    localStorage.setItem("clutch_llm_active", name);
    renderLlmProfiles(name);
  }
  var llmProfileModal = $("#llm-profile-modal");
  var llmProfileTitle = $("#llm-profile-title");
  var llmProfileError = $("#llm-profile-error");
  var editingProfile = null;
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
  function openLlmProfileEditor(name = null) {
    const p = name ? llmProfiles()[name] : null;
    editingProfile = name && p ? name : null;
    llmProfileTitle.textContent = editingProfile ? "Edit profile: " + editingProfile : "New LLM profile";
    profileNameInput.value = editingProfile || "";
    llmUrlInput.value = p && p.base_url || "";
    keyInput.value = p && p.api_key || "";
    modelInput.value = p && p.model || "";
    reasoningEffortInput.value = p && p.reasoning_effort || "";
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
    const taken = llmProfiles()[name];
    if (taken && name !== editingProfile) {
      showLlmProfileError('A profile named "' + name + '" already exists \u2014 pick a different name.');
      profileNameInput.focus();
      return;
    }
    const oldName = editingProfile;
    editingProfile = null;
    saveProfileAs(name, oldName);
    closeModal(llmProfileModal);
    await pushSettings();
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
    if (!name) return;
    const yes = await askConfirm({
      title: "Delete LLM profile",
      text: 'Delete profile "' + name + '"?',
      ok: "Delete"
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
    renderLlmProfiles(localStorage.getItem("clutch_llm_active") || "");
    paintAbout();
    showSettingsTab("llm");
  }
  function closeSettings() {
    closeModal(modal);
  }
  function aboutVersion() {
    const v = String(window.CLUTCH_VERSION == null ? "" : window.CLUTCH_VERSION).trim();
    return v || "dev build";
  }
  function aboutPlatform() {
    const ua = String(navigator && navigator.userAgent || "");
    const grab = (re) => {
      const m = ua.match(re);
      return m ? m[1] : "";
    };
    const electron = grab(/Electron\/([\d.]+)/);
    const android = grab(/Android\s+([\d.]+)/);
    const chrome = grab(/(?:Chrome|Chromium)\/(\d+)/);
    const system = android ? "Android " + android : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux|X11/.test(ua) ? "Linux" : "unknown system";
    const shell = electron ? "Electron " + electron : android ? "Android WebView" : "browser";
    return [system, shell, chrome ? "Chromium " + chrome : ""].filter(Boolean).join(" \xB7 ");
  }
  function aboutBackend() {
    return state.apiBase || "not connected";
  }
  function paintAbout() {
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set("about-version", aboutVersion());
    set("about-platform", aboutPlatform());
    set("about-backend", aboutBackend());
  }
  var SETTINGS_TABS = ["llm", "plugins", "about"];
  var SETTINGS_HEIGHT_MS = 420;
  var settingsHeightAnim = null;
  function settingsBoxWants(box) {
    box.style.height = "";
    return box.getBoundingClientRect().height;
  }
  function settingsHeightStop() {
    if (!settingsHeightAnim) return;
    const anim = settingsHeightAnim;
    settingsHeightAnim = null;
    cancelAnimationFrame(anim.raf);
    anim.box.style.height = "";
  }
  function settingsHeightEase(p) {
    return 1 - Math.pow(1 - p, 3);
  }
  function settingsHeightStep(anim, now) {
    if (settingsHeightAnim !== anim) return;
    const first = !anim.t0;
    if (first) anim.t0 = now;
    const want = settingsBoxWants(anim.box);
    const p = Math.min(1, (now - anim.t0) / SETTINGS_HEIGHT_MS);
    if (!want || p >= 1 || first && Math.abs(want - anim.from) < 1) {
      settingsHeightAnim = null;
      anim.box.style.height = "";
      return;
    }
    anim.box.style.height = anim.from + (want - anim.from) * settingsHeightEase(p) + "px";
    anim.raf = requestAnimationFrame((t) => settingsHeightStep(anim, t));
  }
  function showSettingsTab(name) {
    const tab = SETTINGS_TABS.includes(name) ? name : "llm";
    const swap = () => {
      for (const t of SETTINGS_TABS) {
        const btn = $("#settings-tab-" + t);
        const on = t === tab;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", String(on));
        $("#settings-pane-" + t).classList.toggle("hidden", !on);
      }
    };
    const box = $("#settings-modal .modal-box");
    const measurable = box && typeof box.getBoundingClientRect === "function";
    const from = measurable ? box.getBoundingClientRect().height : 0;
    settingsHeightStop();
    if (!from || reducedMotion()) {
      swap();
      return;
    }
    box.style.height = from + "px";
    swap();
    const anim = { box, from, raf: 0, t0: 0 };
    settingsHeightAnim = anim;
    anim.raf = requestAnimationFrame((t) => settingsHeightStep(anim, t));
  }
  for (const t of SETTINGS_TABS) {
    $("#settings-tab-" + t).addEventListener("click", () => showSettingsTab(t));
  }
  $("#settings-tab-about").addEventListener("click", paintAbout);
  async function pushSettings() {
    const key = keyInput.value.trim();
    const llmUrl = llmUrlInput.value.trim();
    const model = modelInput.value.trim();
    const payload = {
      base_url: llmUrl,
      model,
      // always sent: empty values clear the knobs on the backend
      reasoning_effort: reasoningEffortInput.value.trim(),
      api_protocol: apiProtocolInput.value.trim()
    };
    if (key) payload.api_key = key;
    try {
      if (key) localStorage.setItem("clutch_api_key", key);
      localStorage.setItem("clutch_llm", JSON.stringify({ model, base_url: llmUrl }));
      if (window.clutchSettings && window.clutchSettings.save) {
        const reply = await window.clutchSettings.save({
          api_key: key,
          model,
          base_url: llmUrl,
          reasoning_effort: payload.reasoning_effort,
          api_protocol: payload.api_protocol
        });
        if (reply && reply.ok === false) {
          throw new Error("~/.clutch/settings.json was not written: " + (reply.error || "the host refused it"));
        }
      }
      try {
        await apiFetch("/api/settings", { method: "POST", body: payload });
      } catch (e) {
        console.warn("[settings] the session did not take the update; the next run will:", e);
      }
      document.dispatchEvent(new CustomEvent("clutch:settings-saved"));
      return true;
    } catch (e) {
      addEvent({ type: "final", status: "error", summary: "save settings failed: " + e.message });
      return false;
    }
  }
  $("#settings-close").addEventListener("click", closeSettings);
  dismissOnOverlayPress(modal, closeSettings);
  function dismissOnOverlayPress(overlayEl, onClose) {
    overlayEl.addEventListener("mousedown", (e) => {
      if (e.target === overlayEl) onClose();
    });
  }
  var MODAL_CLOSE_MS = 200;
  function closeModal(overlayEl, onDone = null) {
    if (!overlayEl || overlayEl.classList.contains("hidden") || overlayEl.classList.contains("closing")) return;
    const finish = () => {
      if (!overlayEl.classList.contains("closing")) return;
      overlayEl.classList.remove("closing");
      overlayEl.classList.add("hidden");
      if (onDone) onDone();
    };
    overlayEl.classList.add("closing");
    if (reducedMotion()) finish();
    else setTimeout(finish, MODAL_CLOSE_MS);
  }
  var noticeTimer = null;
  function notice(message, kind = "error") {
    const el = document.getElementById("notice");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden");
    el.classList.toggle("error", kind === "error");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => el.classList.add("hidden"), kind === "error" ? 8e3 : 4e3);
  }
  var corruptReported = /* @__PURE__ */ new Set();
  function corruptRecord(what, key, why) {
    let raw = null;
    try {
      raw = localStorage.getItem(key);
    } catch (e) {
    }
    if (raw) {
      try {
        localStorage.setItem(key + ".corrupt", raw);
      } catch (e) {
      }
    }
    if (corruptReported.has(key)) return;
    corruptReported.add(key);
    const detail = why && why.message || String(why || "it is not the JSON this build writes");
    notice(`The ${what} could not be read (${detail}). Its bytes were kept as "${key}.corrupt", not thrown away.`);
  }
  var confirmModal = $("#confirm-modal");
  var confirmResolve = null;
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
    confirmResolve = null;
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

  // src/renderer/conn-store.ts
  var connSelect = customSelect($("#conn-select"));
  var connStatus = $("#conn-status");
  if (IS_ANDROID) $("#conn-cancel").title = "abort the connection attempt";
  var connNewHost = $("#conn-new-host");
  var connNewUser = $("#conn-new-user");
  var connNewPort = $("#conn-new-port");
  var passModal = $("#ssh-pass-modal");
  var passInput = $("#ssh-pass-input");
  var passLabel = $("#ssh-pass-label");
  var CONNS_KEY = "clutch_ssh_connections";
  function sshConns() {
    const raw = localStorage.getItem(CONNS_KEY);
    if (raw === null) return [];
    let list;
    try {
      list = JSON.parse(raw);
      if (!Array.isArray(list) || list.some((c) => !c || typeof c.host !== "string"))
        throw new Error("it is not a list of hosts");
    } catch (e) {
      corruptRecord("saved SSH hosts", CONNS_KEY, e);
      return [];
    }
    return list;
  }
  function upsertConn(host, user, port) {
    const list = sshConns().filter((c) => !(c.host === host && c.user === user && String(c.port) === String(port)));
    list.unshift({ host, user, port: String(port) });
    localStorage.setItem(CONNS_KEY, JSON.stringify(list));
    localStorage.setItem("clutch_ssh_host", host);
    localStorage.setItem("clutch_ssh_user", user);
    localStorage.setItem("clutch_ssh_port", String(port));
  }
  function connLabel(c) {
    return `${c.user}@${c.host}:${c.port}`;
  }
  var connOnValue = "";
  function connTarget() {
    const chosen = connSelect.value;
    if (!chosen || chosen === connOnValue) return "";
    return chosen;
  }
  var connBusy = false;
  function updateConnConnect() {
    $("#conn-connect").disabled = connBusy || !connTarget();
    $("#conn-new-connect").disabled = connBusy;
  }
  function setConnBusy(b) {
    connBusy = b;
    updateConnConnect();
  }
  function renderConnSelector() {
    const override = sessionStorage.getItem("clutch_api_url");
    const connected = !!(override && localStorage.getItem("clutch_ssh_connected") && state.apiBase);
    const cHost = localStorage.getItem("clutch_ssh_host");
    const cUser = localStorage.getItem("clutch_ssh_user");
    const cPort = localStorage.getItem("clutch_ssh_port");
    const hosts = sshConns();
    connSelect.innerHTML = "";
    if (!IS_ANDROID) {
      const localOpt = document.createElement("option");
      localOpt.value = "local";
      localOpt.textContent = "Local (this machine)";
      connSelect.appendChild(localOpt);
    }
    let connectedValue = null;
    for (const c of hosts) {
      const label = connLabel(c);
      const isConnected = connected && c.host === cHost && c.user === cUser && String(c.port) === String(cPort);
      const opt = document.createElement("option");
      opt.value = "ssh:" + label;
      opt.textContent = label;
      if (isConnected) opt.mark = "\u2713";
      connSelect.appendChild(opt);
      if (isConnected) connectedValue = opt.value;
    }
    let onValue = "";
    if (connected) {
      if (connectedValue) {
        connSelect.value = connectedValue;
      } else {
        const opt = document.createElement("option");
        opt.value = "ssh:__connected__";
        opt.textContent = cHost ? cUser + "@" + cHost + (cPort ? ":" + cPort : "") : "SSH: " + override;
        opt.mark = "\u2713";
        connSelect.appendChild(opt);
        connSelect.value = "ssh:__connected__";
      }
      onValue = connSelect.value;
    } else if (!IS_ANDROID) {
      connSelect.value = "local";
      if (state.apiBase) onValue = "local";
    } else if (hosts.length) {
      connSelect.value = "ssh:" + connLabel(hosts[0]);
    }
    connOnValue = onValue;
    connSelect.disabled = IS_ANDROID && !hosts.length;
    updateConnConnect();
    connStatus.textContent = connected ? "Connected: " + override : state.apiBase ? "Using " + state.apiBase : "Not connected \u2014 no backend";
  }

  // src/renderer/conn-flow.ts
  function refreshPicker() {
    resetConnChrome();
    loadDir("", false);
    renderConnSelector();
  }
  function showPasswordPrompt(label) {
    return new Promise((resolve) => {
      passLabel.textContent = label;
      passInput.value = "";
      state.passResolve = resolve;
      passModal.classList.remove("hidden", "closing");
      passInput.focus();
    });
  }
  function closePasswordPrompt() {
    closeModal(passModal);
    connLostNeedsUser();
    if (state.passResolve) state.passResolve(null);
    state.passResolve = null;
  }
  var lastConn = null;
  var fsListing = false;
  function setFsListing(on) {
    if (fsListing === on) return;
    fsListing = on;
    syncConnConnect();
  }
  function syncConnConnect() {
    const folded = $("#fs-body").classList.contains("collapsed");
    const busy2 = connBusy || fsListing || !$("#conn-actions").classList.contains("hidden");
    $("#conn-connect").classList.toggle("hidden", !folded || busy2);
    updateConnConnect();
  }
  function hidePickerBody() {
    state.fsListToken++;
    setFsListing(false);
    $("#fs-body").classList.add("collapsed");
    syncConnConnect();
  }
  function showPickerBody() {
    $("#fs-body").classList.remove("collapsed");
    resetConnChrome();
  }
  function resetConnChrome() {
    $("#conn-progress").classList.add("hidden");
    $("#conn-new-progress").classList.add("hidden");
    $("#conn-actions").classList.add("hidden");
    syncConnConnect();
  }
  var activeConnStatus = null;
  var activeDoor = "";
  var CONN_STAGES = {
    auth: { pct: 10, label: "Connecting\u2026" },
    probe: { pct: 22, label: "Inspecting remote\u2026" },
    // the gate's own stage: a remote that already runs our version never reaches
    // "install", so reconnecting to a healthy server must not claim it does
    check: { pct: 30, label: "Checking remote server\u2026" },
    install: { pct: 35, label: "Installing remote server\u2026" },
    // the artifact itself: a Release download (or a first-time build on the
    // desktop), and the only part of an install that can take minutes. It has its
    // own stage so it cannot hide inside the check above — that is what made a
    // connect on a phone look like it "only checks the remote server" and never
    // installs (report #5)
    "install:fetch": { pct: 40, label: "Preparing remote server\u2026" },
    // `span`: the stage has measured work to show, and a fraction of it moves the
    // bar. The upload is 78 MB of bundle and takes as long as the link takes — a
    // label frozen at 45% for a minute is how a live transfer reads as a hung one
    "install:upload": { pct: 45, span: 25, label: "Uploading server\u2026" },
    "install:start": { pct: 70, label: "Starting server\u2026" },
    forward: { pct: 90, label: "Starting tunnel\u2026" }
  };
  function fmtRate(bps) {
    const n = Number(bps) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB/s";
    if (n >= 1024) return Math.round(n / 1024) + " KB/s";
    return Math.round(n) + " B/s";
  }
  function fmtEta(secs) {
    const s = Math.max(0, Math.round(Number(secs) || 0));
    if (s >= 3600) {
      const h = Math.floor(s / 3600);
      const m = Math.round(s % 3600 / 60);
      return h + " h" + (m ? " " + m + " min" : "");
    }
    if (s >= 60) return Math.round(s / 60) + " min";
    return s + " s";
  }
  function updateConnProgress(update) {
    const stage = typeof update === "string" ? update : update && update.stage;
    const frac = update && typeof update === "object" && typeof update.frac === "number" ? Math.max(0, Math.min(1, update.frac)) : null;
    const bps = update && typeof update === "object" && typeof update.bps === "number" && update.bps > 0 ? update.bps : null;
    const eta = update && typeof update === "object" && typeof update.eta === "number" && update.eta > 0 ? update.eta : null;
    const s = CONN_STAGES[stage];
    const pane2 = activeDoor === "load";
    let label = "Working\u2026";
    if (s) {
      label = s.label;
      if (frac !== null) label = s.label.replace(/\s*…$/, "") + (pane2 ? "" : " " + Math.round(frac * 100) + "%");
      if (frac !== null && bps) {
        label += " \xB7 " + fmtRate(bps);
        if (eta) label += " \xB7 " + fmtEta(eta) + " left";
      }
    }
    if (activeConnStatus) activeConnStatus.textContent = label;
    const pct = s ? s.pct + (frac !== null ? (s.span || 0) * frac : 0) : null;
    if (pane2) reportHopStage(pct, label);
    for (const bar2 of [$("#conn-progress"), $("#conn-new-progress"), $("#conn-lost-progress")]) {
      if (bar2.classList.contains("hidden")) continue;
      const fill = bar2.querySelector(".conn-progress-fill");
      if (s) {
        fill.classList.remove("indeterminate");
        fill.style.width = s.pct + (frac !== null ? (s.span || 0) * frac : 0) + "%";
      } else {
        fill.classList.add("indeterminate");
        fill.style.width = "";
      }
    }
  }
  function connBarWaiting(bar2) {
    bar2.classList.remove("hidden");
    const fill = bar2.querySelector(".conn-progress-fill");
    fill.classList.add("indeterminate");
    fill.style.width = "";
  }
  function doorOf(statusEl) {
    if (!statusEl) return "bar";
    if (statusEl.id === "conn-new-status") return "popup";
    if (statusEl.id === "conn-lost-why") return "lost";
    return "bar";
  }
  function setFsConnecting(host, statusEl, door) {
    activeConnStatus = statusEl;
    activeDoor = door;
    if (door === "lost") {
      syncConnConnect();
      return;
    }
    if (door === "load") {
      reportHopStage(null, "Connecting to " + host + "\u2026");
      syncConnConnect();
      return;
    }
    statusEl.textContent = "Connecting to " + host + "\u2026";
    if (door === "bar") {
      $("#conn-actions").classList.add("hidden");
      hidePickerBody();
    }
    connBarWaiting(door === "popup" ? $("#conn-new-progress") : $("#conn-progress"));
    syncConnConnect();
  }
  function setFsConnectError(msg, statusEl, door) {
    activeConnStatus = statusEl;
    activeDoor = door;
    statusEl.textContent = msg;
    if (door === "popup") {
      $("#conn-new-progress").classList.add("hidden");
      return;
    }
    if (door === "lost") {
      return;
    }
    if (door === "load") {
      return;
    }
    $("#conn-progress").classList.add("hidden");
    $("#conn-new-progress").classList.add("hidden");
    $("#conn-actions").classList.remove("hidden");
    hidePickerBody();
  }
  async function hopLandedFor(host, user, port, budgetMs = 5e3) {
    const st = window.clutchTunnel && window.clutchTunnel.status;
    if (typeof st !== "function") return false;
    const wantPort = Number(port) || 22;
    const deadline = Date.now() + budgetMs;
    for (; ; ) {
      let s = null;
      try {
        s = await st();
      } catch (e) {
        return false;
      }
      const t = s && s.target;
      const mine = t && t.host === String(host) && t.user === String(user) && (Number(t.port) || 22) === wantPort;
      if (s && mine && s.active && s.url) return true;
      if (!s || !mine || !s.active) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  async function handleSshConnect(host, user, port, statusEl) {
    connLostExitClear();
    if (!window.clutchTunnel) {
      statusEl.textContent = "SSH requires the desktop app (Electron).";
      return;
    }
    if (connBusy) {
      statusEl.textContent = "connecting\u2026";
      return;
    }
    if (!host || !user) {
      statusEl.textContent = "host and user are required";
      return;
    }
    const door = doorOf(statusEl);
    if (door === "bar") lastConn = { host, user, port, statusEl };
    setConnBusy(true);
    setFsConnecting(host, statusEl, door);
    try {
      let res = await window.clutchTunnel.connect({ host, user, port: Number(port) });
      if (!res.ok && res.error && /authentication/i.test(res.error)) {
        const pw = await showPasswordPrompt("Password / key passphrase for " + user + "@" + host);
        if (!pw) {
          setFsConnectError("connection cancelled", statusEl, door);
          return;
        }
        res = await window.clutchTunnel.connect({ host, user, port: Number(port), password: pw });
      }
      if (!res.ok && await hopLandedFor(host, user, port)) res = { ok: true, url: null };
      if (res.ok) {
        upsertConn(host, user, port);
        localStorage.setItem("clutch_ssh_connected", "1");
        await switchBackendResolved();
        refreshPicker();
        return true;
      } else {
        const degraded = await tryDegradeToSshTools();
        if (degraded === true) {
          upsertConn(host, user, port);
          localStorage.setItem("clutch_ssh_connected", "1");
          await switchBackendResolved();
          refreshPicker();
          return true;
        }
        setFsConnectError(
          degraded === false ? "connection failed: " + (res.error || "could not connect") : "SSH connected, but the local agent server is " + degraded + (res.error ? " (" + res.error + ")" : ""),
          statusEl,
          door
        );
      }
    } catch (e) {
      setFsConnectError("connection failed: " + e.message, statusEl, door);
    } finally {
      setConnBusy(false);
      syncConnConnect();
    }
  }
  async function connectTabMachine(machine) {
    const host = machine && machine.host;
    const user = machine && machine.user;
    const port = Number(machine && machine.port || 22);
    if (!host || !user) return "";
    if (!(window.clutchTunnel && window.clutchTunnel.connect)) {
      return "this shell cannot open an SSH tunnel";
    }
    if (connBusy) return "another connection is already in progress";
    setConnBusy(true);
    setFsConnecting(host, null, "load");
    let up = false;
    try {
      let res = await window.clutchTunnel.connect({ host, user, port });
      if (!res.ok && res.error && /authentication/i.test(res.error)) {
        const pw = await showPasswordPrompt("Password / key passphrase for " + user + "@" + host);
        if (!pw) return "connection cancelled";
        res = await window.clutchTunnel.connect({ host, user, port, password: pw });
      }
      if (!res.ok && await hopLandedFor(host, user, port)) res = { ok: true, url: null };
      if (res.ok) {
        upsertConn(host, user, port);
        localStorage.setItem("clutch_ssh_connected", "1");
        up = true;
        return "";
      }
      return "connection failed: " + (res.error || "could not connect");
    } catch (e) {
      return "connection failed: " + (e && e.message || e);
    } finally {
      paneHopSettled(up);
      activeConnStatus = null;
      activeDoor = "";
      setConnBusy(false);
      syncConnConnect();
    }
  }
  async function connSwitch(host, user, port, statusEl) {
    if (!host || !user || !window.clutchTunnel || connBusy) {
      return await handleSshConnect(host, user, port, statusEl);
    }
    const leaving = Boolean(localStorage.getItem("clutch_ssh_connected"));
    if (leaving) {
      localStorage.removeItem("clutch_ssh_connected");
      localStorage.removeItem("clutch_degrade");
      if (window.clutchTunnel) await window.clutchTunnel.disconnect();
    }
    const ok = await handleSshConnect(host, user, port, statusEl);
    if (!ok && leaving) {
      if (window.clutchTunnel) {
        try {
          await window.clutchTunnel.disconnect();
        } catch (e) {
        }
      }
      dropStaleBackend();
      if (doorOf(statusEl) === "popup") {
        refreshPicker();
      } else {
        const verdict = statusEl.textContent;
        renderConnSelector();
        statusEl.textContent = verdict;
      }
    }
    return ok;
  }
  async function connConnect(v) {
    connLostExitClear();
    if (!v || v === connOnValue) return;
    if (v === "local") {
      if (localStorage.getItem("clutch_ssh_connected")) {
        localStorage.removeItem("clutch_ssh_connected");
        localStorage.removeItem("clutch_degrade");
        await window.clutchTunnel.disconnect();
        await resetBackendLocal();
      }
      await switchBackendResolved();
      refreshPicker();
      return;
    }
    if (v.startsWith("ssh:") && !v.includes("__connected__")) {
      const [user, hostPort2] = v.slice(4).split("@");
      const [host, port] = hostPort2.split(":");
      await connSwitch(host, user, port || "22", connStatus);
    }
  }
  connSelect.addEventListener("change", () => {
    updateConnConnect();
    connConnect(connSelect.value);
  });
  $("#conn-connect").addEventListener("click", () => connConnect(connTarget()));
  var connNewModal = $("#conn-new-modal");
  var connNewStatus = $("#conn-new-status");
  function openConnNew() {
    connNewHost.value = localStorage.getItem("clutch_ssh_host") || "";
    connNewUser.value = localStorage.getItem("clutch_ssh_user") || "";
    connNewPort.value = localStorage.getItem("clutch_ssh_port") || "22";
    connNewStatus.textContent = "";
    connNewModal.classList.remove("hidden", "closing");
    connNewHost.focus();
  }
  function closeConnNew() {
    closeModal(connNewModal);
  }
  $("#conn-new").addEventListener("click", openConnNew);
  $("#conn-new-cancel").addEventListener("click", closeConnNew);
  $("#conn-new-connect").addEventListener("click", async () => {
    const host = connNewHost.value.trim();
    const user = connNewUser.value.trim();
    const port = connNewPort.value.trim() || "22";
    const ok = await connSwitch(host, user, port, connNewStatus);
    if (ok) closeConnNew();
  });
  dismissOnOverlayPress(connNewModal, closeConnNew);
  connNewHost.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#conn-new-connect").click();
  });
  $("#conn-retry").addEventListener("click", () => {
    if (lastConn) handleSshConnect(lastConn.host, lastConn.user, lastConn.port, lastConn.statusEl);
  });
  $("#conn-cancel").addEventListener("click", async () => {
    localStorage.removeItem("clutch_ssh_connected");
    localStorage.removeItem("clutch_degrade");
    closeConnNew();
    if (!IS_ANDROID) {
      resetBackendLocal();
      await switchBackendResolved();
    }
    refreshPicker();
  });
  if (window.clutchTunnel && window.clutchTunnel.onProgress) {
    window.clutchTunnel.onProgress(updateConnProgress);
  }
  $("#ssh-pass-ok").addEventListener("click", () => {
    const pw = passInput.value;
    closeModal(passModal);
    if (state.passResolve) state.passResolve(pw);
    state.passResolve = null;
  });
  $("#ssh-pass-cancel").addEventListener("click", closePasswordPrompt);
  dismissOnOverlayPress(passModal, closePasswordPrompt);
  passInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#ssh-pass-ok").click();
  });

  // src/renderer/backend-lifecycle.ts
  function switchBackend(url) {
    const clean = url ? String(url).replace(/\/+$/, "") : "";
    if (!clean || clean === SUPERVISOR_BASE) {
      console.warn("[backend] refused a non-session base:", url);
      return false;
    }
    if (busy && clean !== state.apiBase) state.sseRunAtRisk = true;
    state.apiBase = clean;
    sessionStorage.setItem("clutch_api_url", state.apiBase);
    document.dispatchEvent(new CustomEvent("clutch:backend-changed", { detail: state.apiBase }));
    reconnectSSE();
    return true;
  }
  async function switchBackendResolved() {
    if (!switchBackend(await hostSessionUrl())) return false;
    await reapplyDegradeIfNeeded();
    return true;
  }
  async function switchBackendActiveSlot() {
    const tab = activeTab();
    if (!tab) return switchBackendResolved();
    const base = await claimTab(tab);
    if (!base) return false;
    adoptBase(base);
    reconnectSSE();
    await reapplyDegradeIfNeeded();
    return true;
  }
  async function reapplyDegradeIfNeeded() {
    const raw = localStorage.getItem("clutch_degrade");
    if (!raw || !window.clutchTunnel) return;
    const s = await window.clutchTunnel.status();
    if (!s.active || !s.execBridge) {
      localStorage.removeItem("clutch_degrade");
      return;
    }
    let bridge = null;
    try {
      bridge = JSON.parse(raw).bridge;
    } catch (e) {
      localStorage.removeItem("clutch_degrade");
      return;
    }
    try {
      await apiFetch("/api/backend", {
        method: "POST",
        body: { mode: "ssh", bridge, workspace: "~" }
      });
    } catch (e) {
    }
  }
  async function tryDegradeToSshTools() {
    if (!window.clutchTunnel) return false;
    const s = await window.clutchTunnel.status();
    if (!s.active || !s.execBridge) return false;
    const url = await hostSessionUrl();
    if (!url) return "not running";
    try {
      await apiFetch("/api/backend", {
        method: "POST",
        body: { mode: "ssh", bridge: s.execBridge, workspace: "~" },
        base: url
      });
    } catch (e) {
      return e.status ? "not running" : "unreachable";
    }
    localStorage.setItem("clutch_degrade", JSON.stringify({ bridge: s.execBridge }));
    return true;
  }
  async function resetBackendLocal() {
    if (DEFAULT_BASE === SUPERVISOR_BASE) return;
    try {
      await apiFetch("/api/backend", { method: "POST", body: { mode: "local" }, base: DEFAULT_BASE });
    } catch (e) {
    }
  }
  async function reconciledBackendUrl() {
    if (!window.clutchTunnel) return null;
    if (connLostExitPending()) return null;
    const s = await window.clutchTunnel.status();
    const override = sessionStorage.getItem("clutch_api_url");
    const flag = localStorage.getItem("clutch_ssh_connected");
    if (s.active) {
      const target = await hostSessionUrl();
      if (target && override !== target) {
        localStorage.setItem("clutch_ssh_connected", "1");
        return target;
      }
      return null;
    }
    if (flag) {
      if (IS_ANDROID) {
        return null;
      }
      localStorage.removeItem("clutch_ssh_connected");
      await switchBackendResolved();
      return null;
    }
    return null;
  }
  function dropStaleBackend() {
    if (busy) state.sseRunAtRisk = true;
    if (busy && eventsEl) eventsEl.dispatchEvent(new CustomEvent("clutch:turn-interrupted"));
    state.apiBase = null;
    sessionStorage.removeItem("clutch_api_url");
    reconnectSSE();
  }
  if (window.clutchTunnel) {
    window.clutchTunnel.onEnd((info) => {
      localStorage.removeItem("clutch_degrade");
      if (info && info.lost === false) return;
      if (typeof unwatchAll === "function") unwatchAll();
      if (!localStorage.getItem("clutch_ssh_connected")) return;
      const pickerOpen = !fsModal.classList.contains("hidden");
      connectionLost("lost the remote connection");
      if (pickerOpen) refreshPicker();
    });
  }
  if (window.clutchApi && window.clutchApi.onBaseChanged) {
    window.clutchApi.onBaseChanged((change) => {
      const slotId = change && typeof change === "object" ? change.slotId || "" : "";
      const url = change && typeof change === "object" ? change.url : change;
      if (slotId) {
        const tab = tabForSlot(slotId);
        if (tab) tab.base = url ? String(url) : null;
        if (slotId !== state.activeTabId) {
          if (tab) rewatchTab(tab);
          return;
        }
      }
      if (url) {
        switchBackend(url);
        if (!fsModal.classList.contains("hidden")) {
          renderConnSelector();
          loadDir(fsPath, false);
        }
      } else connectionLost("the host has no session for this window");
    });
  }

  // src/renderer/conn-lost.ts
  var connLostModal = $("#conn-lost-modal");
  var connLostReasonEl = $("#conn-lost-reason");
  var connLostTargetEl = $("#conn-lost-target");
  var connLostStatusEl = $("#conn-lost-status");
  var connLostWhyEl = $("#conn-lost-why");
  var connLostProgressEl = $("#conn-lost-progress");
  var connLostActionsEl = $("#conn-lost-actions");
  var connLostRetryBtn = $("#conn-lost-retry");
  var connLostCancelBtn = $("#conn-lost-cancel");
  var CONN_LOST_BACKOFF_MS = [1e3, 2e3, 4e3, 8e3, 16e3, 32e3, 64e3, 128e3];
  var CONN_LOST_WAITING = "Waiting for you";
  var connLost = false;
  var connLostTries = 0;
  var connLostAttempting = false;
  var connLostTimer = null;
  var connLostManualOnly = false;
  function connLostTargetText() {
    const host = localStorage.getItem("clutch_ssh_host");
    const user = localStorage.getItem("clutch_ssh_user");
    const port = localStorage.getItem("clutch_ssh_port");
    if (!host) return "This window's session (no named host to re-attempt).";
    return "Host: " + (user ? user + "@" : "") + host + (port ? ":" + port : "");
  }
  function connLostPaint(status) {
    connLostStatusEl.textContent = status || "";
  }
  function connLostChrome() {
    if (!connLost) return;
    connLostActionsEl.classList.remove("hidden");
    connLostRetryBtn.classList.toggle("hidden", connLostAttempting);
    if (connLostAttempting) {
      connBarWaiting(connLostProgressEl);
    } else {
      connLostProgressEl.classList.add("hidden");
      connLostRetryBtn.focus();
    }
  }
  connLostModal.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
  });
  function connectionLost(reason) {
    if (connLost) return;
    if (connBusy) return;
    connLost = true;
    connLostTries = 0;
    connLostManualOnly = false;
    dropStaleBackend();
    renderConnSelector();
    connLostReasonEl.textContent = reason;
    connLostTargetEl.textContent = connLostTargetText();
    connLostWhyEl.textContent = "";
    connLostPaint("Reconnecting\u2026");
    connLostModal.classList.remove("hidden", "closing");
    connLostModal.focus();
    connLostAttempt();
  }
  function resolveConnectionLost() {
    if (!connLost) return;
    connLost = false;
    connLostManualOnly = false;
    if (connLostTimer) {
      clearTimeout(connLostTimer);
      connLostTimer = null;
    }
    connLostPaint("");
    connLostWhyEl.textContent = "";
    closeModal(connLostModal);
  }
  function connLostNeedsUser() {
    if (!connLost) return;
    connLostManualOnly = true;
    connLostPaint(CONN_LOST_WAITING);
  }
  function connLostCancel() {
    if (!connLost) return;
    localStorage.removeItem("clutch_ssh_connected");
    localStorage.removeItem("clutch_degrade");
    if (connLostTimer) {
      clearTimeout(connLostTimer);
      connLostTimer = null;
    }
    connLost = false;
    connLostManualOnly = false;
    connLostPaint("");
    connLostWhyEl.textContent = "";
    setStatus("idle");
    renderConnSelector();
    closeModal(connLostModal);
    connLostQuit();
  }
  var CONN_LOST_EXIT_MS = 2e3;
  async function boundedDisconnect(ms) {
    let bye = Promise.resolve();
    try {
      if (window.clutchApi && window.clutchApi.releaseSession) {
        bye = Promise.resolve(window.clutchApi.releaseSession()).catch(() => {
        });
      }
    } catch (e) {
    }
    return Promise.race([bye, new Promise((r) => setTimeout(r, ms))]);
  }
  var CONN_LOST_EXIT_KEY = "clutch_conn_lost_exit";
  var CONN_LOST_EXIT_BOOT_MS = 1500;
  function connLostExitMark() {
    try {
      sessionStorage.setItem(CONN_LOST_EXIT_KEY, "1");
    } catch (e) {
    }
  }
  function connLostExitClear() {
    try {
      sessionStorage.removeItem(CONN_LOST_EXIT_KEY);
    } catch (e) {
    }
  }
  function connLostExitPending() {
    try {
      return sessionStorage.getItem(CONN_LOST_EXIT_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  var connLostExitToreDown = false;
  function connLostExitBootTeardown() {
    if (connLostExitToreDown) return Promise.resolve();
    connLostExitToreDown = true;
    return boundedDisconnect(CONN_LOST_EXIT_BOOT_MS);
  }
  async function connLostQuit() {
    connLostExitMark();
    await boundedDisconnect(CONN_LOST_EXIT_MS);
    window.location.reload();
  }
  function connLostArm() {
    if (connLostTimer) clearTimeout(connLostTimer);
    if (!connLost) return;
    if (connLostManualOnly) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const idx = Math.max(0, Math.min(connLostTries - 1, CONN_LOST_BACKOFF_MS.length - 1));
    connLostTimer = setTimeout(() => {
      connLostTimer = null;
      connLostAttempt();
    }, CONN_LOST_BACKOFF_MS[idx]);
  }
  async function connLostAttempt() {
    if (!connLost || connLostAttempting) return;
    connLostAttempting = true;
    connLostTries += 1;
    connLostTimer = null;
    connLostWhyEl.textContent = "";
    connLostChrome();
    if (connLostTries > 1) connLostPaint(`Reconnecting (attempt ${connLostTries})\u2026`);
    let verdict = "";
    try {
      if (await connLostRecover()) {
        return;
      }
      verdict = "Not back yet";
    } catch (e) {
      verdict = "reconnect failed: " + (e && e.message || e);
    } finally {
      connLostAttempting = false;
      connLostChrome();
    }
    if (!connLost) return;
    connLostPaint(connLostManualOnly ? CONN_LOST_WAITING : verdict + " \u2014 retrying.");
    connLostArm();
  }
  async function connLostRecover() {
    const remote = connLostRemoteIntent();
    if (remote && !await connLostTunnelUp()) return connLostRedial(remote);
    if (!remote) return connLostAskHost();
    if (await connLostAskHost()) return true;
    return connLostRedial(remote);
  }
  async function connLostAskHost() {
    const reconnected = await switchBackendActiveSlot() || await switchBackendResolved();
    if (!reconnected) return false;
    return connLostAwaitAnswer();
  }
  function connLostRemoteIntent() {
    const host = localStorage.getItem("clutch_ssh_host");
    const user = localStorage.getItem("clutch_ssh_user");
    if (!host || !user || !localStorage.getItem("clutch_ssh_connected")) return null;
    return { host, user, port: localStorage.getItem("clutch_ssh_port") || "22" };
  }
  function connLostTunnelUp() {
    if (!window.clutchTunnel) return Promise.resolve(false);
    return window.clutchTunnel.status().then((s) => Boolean(s && s.active), () => false);
  }
  async function connLostRedial(intent) {
    const ok = await handleSshConnect(intent.host, intent.user, intent.port, connLostWhyEl);
    if (!ok) return false;
    return connLostAwaitAnswer();
  }
  var CONN_LOST_NOTICE_MS = 8e3;
  function connLostAwaitAnswer(ms = CONN_LOST_NOTICE_MS) {
    if (!connLost) return Promise.resolve(true);
    const deadline = Date.now() + ms;
    return new Promise((resolve) => {
      const tick = () => {
        if (!connLost) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 250);
      };
      tick();
    });
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!connLost || connLostAttempting || connLostTimer) return;
      connLostAttempt();
    });
  }
  $("#conn-lost-retry").addEventListener("click", () => {
    if (!connLost || connLostAttempting) return;
    connLostTries = 0;
    connLostManualOnly = false;
    connLostAttempt();
  });
  $("#conn-lost-cancel").addEventListener("click", () => {
    connLostCancel();
  });

  // src/renderer/app.ts
  var SUPERVISOR_BASE = "http://127.0.0.1:8890";
  var DEFAULT_BASE = SUPERVISOR_BASE;
  async function hostSessionUrl() {
    if (connLostExitPending()) return null;
    if (!(window.clutchApi && window.clutchApi.baseUrl)) return null;
    try {
      const b = await window.clutchApi.baseUrl();
      const clean = b ? String(b).replace(/\/+$/, "") : "";
      if (clean && clean !== SUPERVISOR_BASE) return clean;
    } catch {
    }
    return null;
  }
  async function resolveApiBase() {
    if (connLostExitPending()) {
      await connLostExitBootTeardown();
      return null;
    }
    if (!(window.clutchApi && window.clutchApi.baseUrl)) return state.apiBase;
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = await hostSessionUrl();
      if (url) {
        state.apiBase = url;
        DEFAULT_BASE = url;
        return url;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    return state.apiBase;
  }
  function noBackend() {
    const e = new Error("no backend URL yet \u2014 the session is still starting");
    e.code = "no_backend";
    return e;
  }
  async function apiFetch(path, { method = "GET", body, base = state.apiBase, timeout = 3e4, signal } = {}) {
    if (!base) throw noBackend();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const onAbort = () => {
      try {
        ctl.abort();
      } catch (e) {
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }
    let r;
    try {
      r = await fetch(base + path, body === void 0 ? { method, signal: ctl.signal } : {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      const e = new Error(data.error || r.status);
      e.code = data.code || null;
      e.status = r.status;
      if (data.owner) e.owner = data.owner;
      if (data.project) e.project = data.project;
      throw e;
    }
    return data;
  }

  // src/renderer/update-panel.ts
  var UPDATE_BUTTON_ID = "about-update-btn";
  var UPDATE_NOTE_ID = "about-update-note";
  var updateUi = { label: "Check for updates", note: "", error: false, disabled: false };
  var updateBusy = false;
  var updatePhase = "";
  var updatePlan = null;
  var updateFile = "";
  function updateBridge() {
    const bridge = window.clutchUpdate;
    return bridge && typeof bridge.check === "function" ? bridge : null;
  }
  function updateShell() {
    const shell = window.clutchShell;
    return shell && typeof shell.installApk === "function" ? shell : null;
  }
  function updateVersion() {
    return String(window.CLUTCH_VERSION == null ? "" : window.CLUTCH_VERSION).trim();
  }
  function updateTag(version) {
    return String(version == null ? "" : version).trim().replace(/^v/i, "");
  }
  function updateSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "";
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  function paintUpdate() {
    const button = document.getElementById(UPDATE_BUTTON_ID);
    if (button) {
      button.textContent = updateUi.label;
      button.disabled = updateUi.disabled;
    }
    const note = document.getElementById(UPDATE_NOTE_ID);
    if (note) {
      note.textContent = updateUi.note;
      if (note.classList && typeof note.classList.toggle === "function") {
        note.classList.toggle("error", Boolean(updateUi.error));
      }
    }
  }
  function updateSay(label, note, opts = {}) {
    updateUi.label = label;
    updateUi.note = note || "";
    updateUi.error = Boolean(opts.error);
    updateUi.disabled = Boolean(opts.disabled);
    paintUpdate();
  }
  function updateIdle() {
    const bridge = updateBridge();
    if (!bridge) {
      updateSay(
        "Check for updates",
        "this page is not running inside Clutch, so it has nothing to install. Open the app to update it.",
        { disabled: true }
      );
      return;
    }
    updateSay("Check for updates", "", {});
  }
  async function runUpdate() {
    const bridge = updateBridge();
    if (updateBusy || !bridge) return;
    updateBusy = true;
    try {
      if (updateFile) await installUpdateFile(bridge, updateFile);
      else if (updatePlan && updatePlan.available && updatePlan.asset) await downloadUpdate(bridge);
      else await checkUpdate(bridge);
    } catch (e) {
      updateSay("Try again", "the update failed: " + (e && e.message || String(e)), { error: true });
    } finally {
      updateBusy = false;
    }
  }
  async function checkUpdate(bridge) {
    updatePlan = null;
    updatePhase = "check";
    updateSay("Checking\u2026", "asking the release page which build is newest\u2026", { disabled: true });
    const answer = await bridge.check(updateVersion());
    updatePhase = "";
    if (!answer || !answer.ok) {
      updateSay("Try again", "the check failed: " + (answer && answer.error || "no answer"), { error: true });
      return;
    }
    updatePlan = answer;
    const latest = updateTag(answer.latest);
    const current = updateTag(answer.current) || "this build";
    if (answer.available && answer.asset) {
      const size = updateSize(answer.asset.size);
      updateSay(
        "Install " + (latest || "the update"),
        "Clutch " + (latest || "a newer build") + " is out" + (answer.key ? " for " + answer.key : "") + (size ? " (" + size + ")" : "") + ". Press Install: it downloads here, checks the file against the release, then opens the installer.",
        {}
      );
      return;
    }
    if (answer.reason === "up to date") {
      updateSay(
        "Check for updates",
        "this is the newest release: Clutch " + current + (latest && latest !== current ? " (latest is " + latest + ")" : "") + ".",
        {}
      );
      return;
    }
    updateSay("Check for updates", "nothing to install: " + (answer.reason || "the release has no build for " + answer.key) + ".", {});
  }
  async function downloadUpdate(bridge) {
    const asset = updatePlan && updatePlan.asset || {};
    const label = updateTag(updatePlan && updatePlan.latest);
    updatePhase = "download";
    updateSay("Downloading\u2026", "downloading " + (asset.name || "the update") + "\u2026", { disabled: true });
    const got = await bridge.download();
    updatePhase = "";
    if (!got || !got.ok) {
      updatePlan = null;
      updateSay("Try again", "the download failed: " + (got && got.error || "no answer"), { error: true });
      return;
    }
    updateFile = got.path || "";
    updateSay("Installing\u2026", "the file matches the release; starting the installer for " + (label || "the new build") + "\u2026", {
      disabled: true
    });
    await installUpdateFile(bridge, updateFile);
  }
  async function installUpdateFile(bridge, file) {
    updatePhase = "install";
    const label = updateTag(updatePlan && updatePlan.latest);
    const shell = updateShell();
    updateSay("Installing\u2026", "starting the installer\u2026", { disabled: true });
    let answer = null;
    if (shell) {
      try {
        answer = JSON.parse(String(shell.installApk(file)));
      } catch (e) {
        answer = { error: "the phone's installer answered something unreadable: " + (e && e.message || e) };
      }
    } else {
      answer = await bridge.install(file);
    }
    updatePhase = "";
    if (answer && answer.needsPermission) {
      updateSay(
        "Install",
        "the phone has to allow installs from Clutch first: turn it on in the screen that just opened, then press Install again \u2014 the download is kept.",
        { error: true }
      );
      return;
    }
    if (!answer || !answer.ok) {
      updateSay("Install", "the installer did not start: " + (answer && answer.error || "no answer"), { error: true });
      return;
    }
    updateFile = "";
    const name = label ? "Clutch " + label : "the new build";
    if (shell) {
      updateSay("Installing\u2026", "the phone's installer is opening: confirm it there and Clutch comes back as " + name + ".", {
        disabled: true
      });
      return;
    }
    if (answer.quits === false) {
      updateSay("Installing\u2026", "the installer is open: finish it there, then start Clutch again for " + name + ".", {
        disabled: true
      });
      return;
    }
    updateSay("Restarting\u2026", "Clutch closes now and comes back as " + name + ".", { disabled: true });
  }
  function updateProgress(stage) {
    if (!stage || typeof stage !== "object" || updatePhase !== "download") return;
    const file = String(stage.file || "the update");
    if (stage.phase === "verified") {
      updateSay("Installing\u2026", "the file matches the release; starting the installer\u2026", { disabled: true });
      return;
    }
    if (stage.phase !== "download") return;
    const total = Number(stage.total) || 0;
    const received = Number(stage.received) || 0;
    const percent = total ? Math.min(100, Math.max(0, Math.floor(received * 100 / total))) : 0;
    const line = total ? percent + "% of " + updateSize(total) : updateSize(received);
    updateSay("Downloading\u2026", "downloading " + file + (line ? " \u2014 " + line : "") + "\u2026", { disabled: true });
  }
  function resetUpdate() {
    if (updateBusy || updateFile) return;
    updatePlan = null;
    updatePhase = "";
    updateIdle();
  }
  {
    const button = document.getElementById(UPDATE_BUTTON_ID);
    if (button) button.addEventListener("click", runUpdate);
    const tab = document.getElementById("settings-tab-about");
    if (tab) tab.addEventListener("click", resetUpdate);
    const bridge = updateBridge();
    if (bridge && typeof bridge.onProgress === "function") bridge.onProgress(updateProgress);
    updateIdle();
  }

  // src/renderer/components-panel.ts
  var plugBodyEl = $("#plug-body");
  var plugFilterEl = $("#plug-filter");
  var plugNoteEl = $("#plug-note");
  var plugReloadBtn = $("#plug-reload");
  var plugMirrorInput = $("#mirror-input");
  var plugMirrorSaveBtn = $("#mirror-save");
  var plugMirrorNoteEl = $("#mirror-note");
  var plugState = {
    // the list has answered once — a place that was never read is not a place that
    // holds nothing, and this is the bit that tells the two apart
    read: false,
    sessionBase: "",
    // the session machine supervisor URL, as the view resolved it
    sessionError: null,
    // why the session machine cannot be AIMED at at all
    sessionHeldError: null,
    // why its own list did not arrive (the place itself is reachable)
    client: false,
    // this shell holds a client plugin domain
    clientError: null,
    // why that domain cannot be aimed at (or why it would not open)
    clientHeldError: null,
    // why its own list did not arrive
    held: [],
    // the rows BOTH places hold, each tagged with its own `place`
    // what the last automatic pass over the session machine did — the names it let
    // go of and the ones it could not ({at, installed, retired, deferred, errors}),
    // or null when no pass has run against the machine this window is about
    pass: null,
    market: null,
    // {entries, errors, unreachable}
    marketError: null,
    // why the market read itself failed
    pending: 0,
    // in-flight reads: the note line is derived from them
    mirrors: null,
    // [{url, source}] — the list a failed fetch is retried through, or null while unread
    mirrorsError: null,
    // why that list could not be read
    mirrorForced: "",
    // the prefix every source is forced through, when one is set
    mirrorDraft: "",
    // the mirror being typed into the field (never persisted)
    mirrorBusy: false,
    // an add/remove in flight: the field and the buttons are dead behind it
    mirrorResult: null,
    // {ok, text} — what the list said about the last add or remove
    busy: null,
    // {name, verb, stage} — a write in flight, nothing else may start
    result: null,
    // {ok, text} — the host's verdict on the last write
    versions: null,
    // {name, rows, error} — the one open version list, as just read
    versionsPending: null,
    // name whose version list is being read right now
    versionsSeq: 0,
    // which version-list read is the current one (closing bumps it)
    // the one open settings form: the schema its declaration carries, the values
    // this machine holds, the key a write is in flight for, and what the host said
    // about the last one. Never a copy of anything the page decided itself.
    form: null,
    // {name, schema, values, busy, error, saved}
    formPending: null,
    // name whose settings are being read right now
    formSeq: 0,
    // which settings read is the current one (closing bumps it)
    filter: "all",
    // which slice of the ONE list is on screen (never persisted)
    query: ""
    // the name filter, as typed (never persisted)
  };
  function plugPlace(item) {
    const place = item && item.place;
    if (place === "client") return "this client";
    if (place === "session") return "this session";
    return "";
  }
  function plugPlaceName(item) {
    const place = typeof item === "string" ? item : item && item.place;
    if (place === "client") return "this client";
    if (place === "session") return "this session";
    return "the place its declaration names";
  }
  function plugPlaceUnread(item) {
    return Boolean(item) && item.read === false && !item.problem;
  }
  function plugPlaceReady(place) {
    if (place === "client") {
      return plugState.client ? null : plugState.clientError || "this shell has no client plugin domain, so a plugin has nowhere to go here";
    }
    if (place === "session") {
      if (!plugState.read) {
        return "the components have not been read yet \u2014 nothing is sent to a place this page has not found";
      }
      return plugState.sessionError || null;
    }
    return "this component declares no place, so there is no machine that could receive it";
  }
  function plugHeldError(place) {
    if (place === "client") return plugState.clientHeldError || null;
    if (place === "session") return plugState.sessionHeldError || null;
    return null;
  }
  function plugPlaceUnknown(place) {
    return plugPlaceReady(place) || plugHeldError(place);
  }
  function plugChip(text, cls) {
    const el = document.createElement("span");
    el.className = "plug-chip" + (cls ? " " + cls : "");
    el.textContent = text;
    return el;
  }
  var plugIdSeq = 0;
  function plugFactsNode(text) {
    const el = document.createElement("span");
    el.className = "sr-only";
    el.id = "plug-row-facts-" + ++plugIdSeq;
    el.textContent = text;
    return el;
  }
  function plugDescribeTree(el, id) {
    if (!el || typeof el.setAttribute !== "function") return;
    el.setAttribute("aria-describedby", id);
    for (const child of el.children || []) plugDescribeTree(child, id);
  }
  function plugRow(name, { chips = [], desc = "", lines = [], actions = [], extra = null, state: state2 = null, title = "", role = "" } = {}) {
    const row = document.createElement("div");
    row.className = "plug-row" + (state2 && state2.row ? " " + state2.row : "");
    if (role) row.setAttribute("role", role);
    if (title) row.title = title;
    if (state2 && state2.cls === "busy") row.setAttribute("aria-busy", "true");
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
    if (state2 && state2.text) {
      const el = document.createElement("div");
      el.className = "plug-line plug-state" + (state2.cls ? " " + state2.cls : "");
      el.textContent = state2.text;
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
    if (actions.length) {
      const foot = document.createElement("div");
      foot.className = "plug-row-actions";
      for (const a of actions) foot.appendChild(a);
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
    head.className = "plug-section-title";
    head.textContent = title;
    if (meta) {
      const el = document.createElement("span");
      el.className = "plug-meta";
      el.textContent = meta;
      head.appendChild(el);
    }
    sec.appendChild(head);
    if (rows.length) {
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
  function plugModel() {
    const byName = /* @__PURE__ */ new Map();
    const order = [];
    const slot = (name) => {
      if (!byName.has(name)) {
        byName.set(name, { name, entry: null, held: null });
        order.push(name);
      }
      return byName.get(name);
    };
    for (const e of plugState.market ? plugState.market.entries : []) slot(e.name).entry = e;
    for (const h of plugState.held || []) {
      const cell = slot(h.name);
      if (!cell.held || cell.entry && h.place === cell.entry.place) cell.held = h;
    }
    return order.map((n) => byName.get(n));
  }
  var PLUG_FILTERS = [
    ["all", "All"],
    ["installed", "Installed"],
    ["market", "Market"],
    ["updates", "Updates"],
    ["stopped", "Stopped"]
  ];
  function plugItemUpdate(item) {
    if (!item.held || !item.entry) return false;
    if (plugHeldLegacy(item.held)) return true;
    const offered = String(item.entry.version || "");
    return Boolean(offered) && String(item.held.version || "").split("+")[0] !== offered;
  }
  function plugHeldLegacy(held) {
    const version = String(held && held.version || "");
    return Boolean(version) && !version.includes("+");
  }
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
  var plugFilterChips = null;
  function plugFilterRow() {
    if (plugFilterChips) return plugFilterChips;
    const box = document.createElement("div");
    box.className = "plug-filter-chips";
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
      btn.setAttribute("aria-pressed", String(on));
      const n = items.filter((item) => plugItemMatches(item, id)).length;
      count.textContent = n ? " " + n : "";
    }
  }
  function plugItemChips(item) {
    const chips = [];
    if (item.held && item.held.disabled) chips.push(["stopped", "warn"]);
    return chips;
  }
  function plugItemDesc(item) {
    const held = item.held;
    const entry = item.entry;
    const where = plugPlace(held || entry);
    if (held && held.disabled) return `held on ${where}, but not driven: its tools are not offered here`;
    if (held && entry) {
      return plugItemUpdate(item) ? `installed \u2014 this client offers ${entry.version || "another version"}` : "installed \u2014 nothing newer is offered here";
    }
    if (held) return "installed \u2014 the market does not list it";
    if (entry && entry.problem) return entry.problem;
    if (entry && !plugPlaceUnread(entry) && plugPlaceUnknown(entry.place)) {
      return `on ${where}, unknown`;
    }
    return "not installed";
  }
  function plugItemMeta(item) {
    const meta = [];
    const held = item.held;
    const entry = item.entry;
    if (held) {
      meta.push("held " + (held.version || "at an unnamed version"));
      if (held.digest) meta.push("digest " + String(held.digest).slice(0, 16));
      if (held.disabled) meta.push("stopped");
      if (plugHeldLegacy(held) && entry && entry.version) {
        const digest = String(held.digest || "").slice(0, 16) || String(held.version);
        meta.push(`an old record: a reinstall names it ${entry.version}+${digest}`);
      }
    }
    if (entry) {
      const place = plugPlace(entry);
      if (place) meta.push("goes to " + place);
      else if (plugPlaceUnread(entry)) meta.push("its place is its declaration's, read when something is installed from it");
      if (entry.problem) meta.push("refused: " + entry.problem);
      if (!held) {
        const refuse = plugPlaceUnread(entry) ? "" : plugPlaceUnknown(entry.place);
        if (refuse) meta.push(refuse);
      }
      const from = entry.origin === "checkout" ? "from this checkout" : "from the market";
      meta.push(`offered ${entry.version || "at an unnamed version"} (${from})`);
      if (entry.published && entry.published.version) {
        meta.push(`release under it: ${entry.published.version} \xB7 ${entry.published.source}`);
      }
      if (entry.source) meta.push(entry.source);
    }
    return meta;
  }
  function plugItemLead(item) {
    if (item.entry && !item.held) return "install";
    if (item.held && item.entry && plugItemUpdate(item)) return "update";
    if (item.held) return "switch";
    return null;
  }
  function plugItemActions(item) {
    const lead = plugItemLead(item);
    const actions = [];
    const primary = lead === "install" || lead === "update" ? item.entry ? plugInstallButton(item.entry) : null : lead === "switch" && item.held ? plugSwitchButton(item.held) : null;
    if (primary) actions.push(primary);
    const secondary = plugItemMenuItems(item, lead);
    if (secondary.length) {
      const menu2 = plugMenu(secondary);
      actions.push(plugMoreButton(item, menu2), menu2);
    }
    return actions;
  }
  function plugItemMenuItems(item, lead) {
    const items = [];
    if (!item.held) return items;
    items.push(plugSettingsButton(item.held));
    if (lead !== "switch") items.push(plugSwitchButton(item.held));
    if (item.entry && lead !== "install" && lead !== "update") items.push(plugInstallButton(item.entry));
    items.push(plugVersionsButton(item.held), plugRemoveButton(item.held));
    return items;
  }
  function plugMenu(items) {
    const box = document.createElement("span");
    box.className = "plug-menu";
    box.id = "plug-menu-" + ++plugIdSeq;
    for (const item of items) box.appendChild(item);
    return box;
  }
  function plugMoreButton(item, menu2) {
    const name = item.name;
    const where = plugPlaceName(item.held || item.entry);
    const btn = document.createElement("button");
    btn.className = "plug-more";
    btn.type = "button";
    btn.textContent = "\u2026";
    btn.title = `everything else ${name} can do on ${where}`;
    btn.setAttribute("aria-label", `more actions for ${name} on ${where}`);
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-controls", menu2.id);
    btn.setAttribute("aria-expanded", String(menu2.classList.contains("open")));
    btn.addEventListener("click", (ev) => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      const open = !menu2.classList.contains("open");
      plugCloseMenus();
      menu2.classList.toggle("drop-up", open && !plugMenuFitsBelow(btn, menu2));
      menu2.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    });
    return btn;
  }
  function plugMenuFitsBelow(btn, menu2) {
    if (typeof btn.getBoundingClientRect !== "function") return true;
    if (typeof plugBodyEl.getBoundingClientRect !== "function") return true;
    const anchor = btn.getBoundingClientRect();
    const box = plugBodyEl.getBoundingClientRect();
    const need = typeof menu2.getBoundingClientRect === "function" && menu2.getBoundingClientRect().height || 140;
    return anchor.bottom + need + 8 <= box.bottom;
  }
  function plugCloseMenus() {
    if (typeof plugBodyEl.querySelectorAll !== "function") return;
    for (const el of plugBodyEl.querySelectorAll(".plug-menu.open")) {
      el.classList.remove("open");
      el.classList.remove("drop-up");
      const opener = el.previousElementSibling;
      if (opener && opener.setAttribute) opener.setAttribute("aria-expanded", "false");
    }
  }
  document.addEventListener("click", () => plugCloseMenus());
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
      extra: plugItemExtra(item.held),
      state: plugItemState(item),
      // every fact the row no longer DRAWS is still answered, one hover away: the
      // list is for choosing, the tooltip for confirming (U-10)
      title: plugItemMeta(item).join(" \xB7 ")
    });
  }
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
  function plugEmptyText(known, shown) {
    if (!plugState.read && plugState.market === null) {
      const why = plugReadProblem();
      return why ? "could not be read \u2014 " + why : "reading\u2026";
    }
    if (known && !shown) return "no component here matches this filter";
    return "nothing is installed in either place, and the market lists nothing for this build";
  }
  function plugReadProblem() {
    return plugState.sessionError || plugState.sessionHeldError || plugState.clientError || plugState.clientHeldError || plugState.marketError || null;
  }
  function plugPassLine() {
    const pass = plugState.pass;
    if (!pass) return null;
    const retired = Array.isArray(pass.retired) ? pass.retired : [];
    const errors = Array.isArray(pass.errors) ? pass.errors : [];
    if (!retired.length && !errors.length) return null;
    const at = pass.at ? new Date(pass.at).toTimeString().slice(0, 8) : "";
    const parts = [];
    if (retired.length) {
      const names = retired.map((r) => `${r.name}${r.version ? " " + r.version : ""} (${r.reason})`).join("; ");
      parts.push(`let go of ${retired.length === 1 ? "" : retired.length + " names: "}${names}`);
    }
    if (errors.length) {
      const why = errors.map((e) => `${e.name || "the pass"} (${e.reason})`).join("; ");
      parts.push(`could not let go of ${why}`);
    }
    const el = document.createElement("p");
    el.className = "plug-pass";
    el.textContent = `the components pass ${at ? "at " + at : "run at the last connect"} ${parts.join(", and ")}`;
    return el;
  }
  function plugList() {
    const items = plugModel();
    const shown = items.filter(plugItemShown);
    const meta = [];
    if (plugState.read) meta.push(`${plugState.held.length} installed`);
    else meta.push("reading");
    if (plugState.market) meta.push(`${plugState.market.entries.length} known`);
    else if (plugState.marketError) meta.push("market unreadable");
    if (shown.length !== items.length) meta.push(`${shown.length} shown`);
    const sec = plugSection(
      "Components",
      meta.join(" \xB7 "),
      shown.map(plugItemRow),
      plugEmptyText(items.length, shown.length)
    );
    const pass = plugPassLine();
    if (pass) sec.appendChild(pass);
    if (plugState.market && plugState.market.entries.length) {
      const caution = document.createElement("p");
      caution.className = "plug-caution";
      caution.textContent = "install writes bytes where the declaration puts them, and Remove deletes them \u2014 neither is a rollback, since nothing here keeps a copy of what it replaces or takes away (the switch is the third write: it deletes nothing, and pressing it again is the undo)";
      sec.appendChild(caution);
    }
    for (const reason of plugState.market && plugState.market.errors || []) {
      const el = document.createElement("p");
      el.className = "plug-source-error";
      el.textContent = reason;
      sec.appendChild(el);
    }
    if (plugState.market && plugState.market.unreachable) {
      const hint = document.createElement("p");
      hint.className = "plug-source-hint";
      hint.textContent = `the market index and every release manifest are read from github.com. A fetch that fails for a network reason is retried through the mirrors listed under Mirrors below, and the source mirror box above (it writes "source_mirror" into ~/.clutch/settings.json) moves every read there was. Either way a mirror only moves the bytes: every digest is still checked against the release's own pin`;
      sec.appendChild(hint);
    }
    return sec;
  }
  function plugMirrorRow(entry) {
    const own = entry.source === "user";
    const row = plugRow(entry.url, {
      chips: [[own ? "yours" : "shipped"]],
      desc: own ? "tried before the entries this build ships" : "shipped by this build: always tried, never removable",
      actions: own ? [plugMirrorRemoveButton(entry.url)] : [],
      role: "listitem"
    });
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
    btn.title = forced ? `every source is already read through ${forced} (CLUTCH_SOURCE_MIRROR, or "source_mirror" in ~/.clutch/settings.json), so this list is not used \u2014 clear that setting to fall back through it` : `stop trying ${url} when a release host cannot be reached`;
    btn.addEventListener("click", () => plugMirrorRemove(url));
    return btn;
  }
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
    input.addEventListener("input", () => {
      plugState.mirrorDraft = input.value || "";
    });
    const btn = document.createElement("button");
    btn.className = "plug-mirrors-add-btn";
    btn.type = "button";
    btn.textContent = plugState.mirrorBusy ? "Adding\u2026" : "Add";
    btn.disabled = Boolean(forced || plugState.mirrorBusy || !String(plugState.mirrorDraft || "").trim());
    btn.title = forced ? `the list is not used while every source is read through ${forced}` : "try this mirror when a release host cannot be reached";
    btn.addEventListener("click", () => plugMirrorAdd());
    wrap.appendChild(input);
    wrap.appendChild(btn);
    return wrap;
  }
  function plugMirrors() {
    const list = plugState.mirrors || [];
    const mine = list.filter((m) => m.source === "user").length;
    const meta = plugState.mirrorsError ? "unreadable" : plugState.mirrors ? `${mine} of yours \xB7 ${list.length - mine} shipped` : "reading\u2026";
    const empty = plugState.mirrorsError ? "the list of mirrors could not be read" : plugState.mirrors ? "no mirror is tried: this build ships none and none was added" : "reading the list\u2026";
    const sec = plugSection("Mirrors", meta, list.map(plugMirrorRow), empty);
    const note = document.createElement("p");
    note.className = "plug-mirrors-note";
    note.textContent = "tried in this order when a release host cannot be reached \u2014 the place a component goes to fetches the same pinned bytes through each one and weighs them against the release's own digest, so a mirror can move the bytes but never vouch for them";
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
      const forced = document.createElement("p");
      forced.className = "plug-mirrors-forced";
      forced.textContent = `every source is read through ${plugState.mirrorForced} before anything else (CLUTCH_SOURCE_MIRROR, or "source_mirror" in ~/.clutch/settings.json), so this list is not used while that is set`;
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
  function plugBusyWord(busy2) {
    if (busy2.verb === "remove") return "being removed";
    if (busy2.verb === "disable") return "being stopped";
    if (busy2.verb === "enable") return "being driven again";
    return "being installed";
  }
  function plugBusyLabel(busy2, fallback) {
    if (busy2.verb === "remove") return "Removing\u2026";
    if (busy2.verb === "disable") return "Stopping\u2026";
    if (busy2.verb === "enable") return "Starting\u2026";
    return fallback;
  }
  function plugSwitchButton(held) {
    const busy2 = plugState.busy && plugState.busy.name === held.name;
    const stopped = Boolean(held.disabled);
    const btn = document.createElement("button");
    btn.className = "plug-switch" + (stopped ? " stopped" : "");
    btn.type = "button";
    btn.textContent = busy2 ? plugBusyLabel(plugState.busy, stopped ? "Starting\u2026" : "Stopping\u2026") : stopped ? "Enable" : "Disable";
    const refuse = plugPlaceReady(held.place);
    const where = plugPlace(held);
    if (refuse) {
      btn.disabled = true;
      btn.title = refuse;
    } else if (!window.clutchComponents || !window.clutchComponents.setDisabled) {
      btn.disabled = true;
      btn.title = "this shell cannot switch components at all";
    } else if (plugState.busy) {
      btn.disabled = true;
      btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
    } else if (stopped) {
      btn.title = `drive ${held.name} on ${where} again \u2014 its bytes stay where they are`;
    } else {
      btn.title = `stop ${where} driving ${held.name} \u2014 it stays installed and listed, its tools are no longer offered, and nothing is deleted`;
    }
    btn.addEventListener("click", () => plugSwitch(held));
    return btn;
  }
  function plugRemoveButton(held) {
    const busy2 = plugState.busy && plugState.busy.name === held.name;
    const btn = document.createElement("button");
    btn.className = "plug-remove";
    btn.type = "button";
    btn.textContent = busy2 ? plugBusyLabel(plugState.busy, "Removing\u2026") : "Remove";
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
  function plugVersionsButton(held) {
    const open = Boolean(plugState.versions && plugState.versions.name === held.name);
    const reading = plugState.versionsPending === held.name;
    const btn = document.createElement("button");
    btn.className = "plug-versions" + (open ? " open" : "");
    btn.type = "button";
    btn.textContent = reading ? "Reading\u2026" : open ? "Hide versions" : "Versions";
    btn.setAttribute("aria-expanded", String(open));
    const refuse = plugPlaceReady(held.place);
    if (refuse) {
      btn.disabled = true;
      btn.title = refuse;
    } else if (!window.clutchComponents || !window.clutchComponents.versions) {
      btn.disabled = true;
      btn.title = "this shell cannot read a version list at all";
    } else if (reading) {
      btn.disabled = true;
      btn.title = `reading the versions of ${held.name} on ${plugPlace(held)}\u2026`;
    } else if (open) {
      btn.title = `close the version list for ${held.name}`;
    } else {
      btn.title = `every version of ${held.name} that ${plugPlace(held)} holds, newest first \u2014 the marked one is what that place runs`;
    }
    btn.addEventListener("click", () => plugVersionsToggle(held));
    return btn;
  }
  function plugVersionRows(held) {
    const reading = plugState.versionsPending === held.name;
    const state2 = plugState.versions;
    if (!reading && !(state2 && state2.name === held.name)) return null;
    const box = document.createElement("div");
    box.className = "plug-versions-box";
    const line = (text) => {
      const el = document.createElement("div");
      el.className = "plug-line";
      el.textContent = text;
      box.appendChild(el);
    };
    if (reading) {
      line("reading the versions held there\u2026");
      return box;
    }
    if (state2.error) {
      line("could not be read \u2014 " + state2.error);
      return box;
    }
    if (!state2.rows.length) {
      line("no version of it is held here now");
      return box;
    }
    for (const record of state2.rows) {
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
  function plugItemExtra(held) {
    if (!held) return null;
    const boxes = [plugVersionRows(held), plugSettingsRows(held)].filter(Boolean);
    if (!boxes.length) return null;
    if (boxes.length === 1) return boxes[0];
    const wrap = document.createElement("div");
    wrap.className = "plug-row-extra";
    for (const box of boxes) wrap.appendChild(box);
    return wrap;
  }
  function plugSettingsButton(held) {
    const btn = document.createElement("button");
    btn.type = "button";
    const open = Boolean(plugState.form && plugState.form.name === held.name);
    btn.className = "plug-settings" + (open ? " open" : "");
    btn.textContent = "Settings\u2026";
    const refuse = plugPlaceReady(held.place);
    if (refuse) {
      btn.disabled = true;
      btn.title = refuse;
    } else if (!window.clutchComponents || !window.clutchComponents.settings) {
      btn.disabled = true;
      btn.title = "this shell cannot read component settings at all";
    } else if (open) {
      btn.title = "close what " + held.name + " lets you set";
    } else {
      btn.title = `what ${held.name} lets you set on ${plugPlace(held)} \u2014 the values live with the component, on the machine that runs it`;
    }
    btn.addEventListener("click", () => plugSettingsToggle(held.name));
    return btn;
  }
  function plugSettingsToggle(name) {
    if (plugState.form && plugState.form.name === name) {
      plugState.form = null;
      plugState.formPending = null;
      plugState.formSeq++;
      renderPlugins();
      return;
    }
    plugState.form = null;
    plugReadSettings(name);
  }
  function plugReadSettings(name) {
    const api = window.clutchComponents;
    if (!api || !api.settings) return;
    const seq = ++plugState.formSeq;
    plugState.form = null;
    plugState.formPending = name;
    renderPlugins();
    api.settings(name).then((r) => {
      if (seq !== plugState.formSeq) return;
      plugState.formPending = null;
      plugState.form = r && r.ok ? { name, schema: r.schema || {}, values: r.values || {}, busy: null, error: null, saved: null } : { name, schema: {}, values: {}, busy: null, error: r && r.error || "the machine gave no answer", saved: null };
    }).catch((e) => {
      if (seq !== plugState.formSeq) return;
      plugState.formPending = null;
      plugState.form = { name, schema: {}, values: {}, busy: null, error: e && e.message || String(e), saved: null };
    }).then(() => {
      if (seq === plugState.formSeq) renderPlugins();
    });
  }
  function plugWriteSetting(name, key, value) {
    const api = window.clutchComponents;
    const form = plugState.form;
    if (!api || !api.setSetting || !form || form.name !== name || form.busy) return;
    const seq = plugState.formSeq;
    form.busy = key;
    form.error = null;
    form.saved = null;
    renderPlugins();
    api.setSetting(name, { [key]: value }).then((r) => {
      if (seq !== plugState.formSeq) return;
      form.busy = null;
      if (r && r.ok) {
        form.values = r.values || form.values;
        form.saved = key;
      } else {
        form.error = r && r.error || "the machine gave no answer";
      }
      renderPlugins();
    }).catch((e) => {
      if (seq !== plugState.formSeq) return;
      form.busy = null;
      form.error = e && e.message || String(e);
      renderPlugins();
    });
  }
  function plugSettingSame(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function plugSettingsRows(held) {
    const reading = plugState.formPending === held.name;
    const form = plugState.form && plugState.form.name === held.name ? plugState.form : null;
    if (!reading && !form) return null;
    const box = document.createElement("div");
    box.className = "plug-settings-box";
    const line = (text, cls = "") => {
      const el = document.createElement("div");
      el.className = "plug-line" + (cls ? " " + cls : "");
      el.textContent = text;
      box.appendChild(el);
    };
    if (reading) {
      line("reading the settings it declares\u2026");
      return box;
    }
    const keys = Object.keys(form.schema || {}).sort();
    if (!keys.length) {
      line(
        form.error ? "could not be read \u2014 " + form.error : "it declares no settings \u2014 there is nothing here to set",
        form.error ? "error" : ""
      );
      return box;
    }
    for (const key of keys) {
      const spec = form.schema[key] && typeof form.schema[key] === "object" ? form.schema[key] : {};
      box.appendChild(plugSettingRow(held, key, spec, form));
    }
    if (form.error) line(form.error, "error");
    else if (form.saved)
      line(`${form.saved} is set \u2014 it takes effect the next time ${held.name} runs`, "saved");
    return box;
  }
  function plugSettingRow(held, key, spec, form) {
    const row = document.createElement("div");
    const modified = !plugSettingSame(form.values[key], spec.default);
    row.className = "plug-setting" + (modified ? " modified" : "");
    const main = document.createElement("div");
    main.className = "plug-setting-main";
    const head = document.createElement("div");
    head.className = "plug-setting-head";
    const label = document.createElement("label");
    label.className = "plug-setting-label";
    label.textContent = key;
    label.htmlFor = "plug-setting-" + held.name + "-" + ++plugIdSeq;
    head.appendChild(label);
    if (modified) head.appendChild(plugChip("set", "accent"));
    main.appendChild(head);
    const desc = document.createElement("div");
    desc.className = "plug-setting-desc";
    desc.textContent = String(spec.description || "");
    if (desc.textContent) main.appendChild(desc);
    row.appendChild(main);
    const ctl = document.createElement("div");
    ctl.className = "plug-setting-ctl";
    ctl.appendChild(plugSettingControl(held, key, spec, form, label.htmlFor));
    if (modified) ctl.appendChild(plugSettingResetButton(held, key, spec, form));
    row.appendChild(ctl);
    return row;
  }
  function plugSettingControl(held, key, spec, form, id) {
    const dead = Boolean(form.busy);
    const write = (value2) => plugWriteSetting(held.name, key, value2);
    const kind = String(spec.type || "string");
    const value = form.values[key];
    if (kind === "boolean") {
      const input2 = document.createElement("input");
      input2.type = "checkbox";
      input2.className = "plug-setting-check";
      input2.id = id;
      input2.checked = value === true;
      input2.disabled = dead;
      input2.addEventListener("change", () => write(input2.checked));
      return input2;
    }
    if (kind === "enum") {
      const options = Array.isArray(spec.enum) ? spec.enum : [];
      const sel = document.createElement("select");
      sel.className = "plug-setting-select";
      sel.id = id;
      sel.disabled = dead;
      for (const option of options) {
        const el = document.createElement("option");
        el.value = String(option);
        el.textContent = String(option);
        if (String(option) === String(value)) el.selected = true;
        sel.appendChild(el);
      }
      sel.addEventListener("change", () => write(sel.value));
      return sel;
    }
    const input = document.createElement("input");
    input.id = id;
    input.className = "plug-setting-input";
    input.disabled = dead;
    if (kind === "number" || kind === "integer") {
      input.type = "number";
      input.step = kind === "integer" ? "1" : "any";
      input.value = value === void 0 || value === null ? "" : String(value);
      input.addEventListener("change", () => {
        const n = Number(input.value);
        if (input.value.trim() === "" || Number.isNaN(n)) {
          input.value = value === void 0 || value === null ? "" : String(value);
          return;
        }
        write(n);
      });
      return input;
    }
    input.type = "text";
    if (kind === "array") {
      input.className += " plug-setting-list";
      input.value = Array.isArray(value) ? value.join(", ") : "";
      input.title = "separate words with commas";
      input.addEventListener(
        "change",
        () => write(
          input.value.split(",").map((word) => word.trim()).filter(Boolean)
        )
      );
      return input;
    }
    input.value = typeof value === "string" ? value : value === void 0 || value === null ? "" : String(value);
    input.addEventListener("change", () => write(input.value));
    return input;
  }
  function plugSettingResetButton(held, key, spec, form) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plug-setting-reset";
    btn.textContent = "Reset";
    btn.disabled = Boolean(form.busy);
    btn.title = `set ${key} back to ${JSON.stringify(spec.default)}`;
    btn.addEventListener("click", () => plugWriteSetting(held.name, key, spec.default));
    return btn;
  }
  function plugRemoveOneButton(held, record) {
    const version = String(record.version || "");
    const busy2 = plugState.busy && plugState.busy.name === held.name;
    const btn = document.createElement("button");
    btn.className = "plug-remove plug-remove-one";
    btn.type = "button";
    btn.textContent = busy2 ? plugBusyLabel(plugState.busy, "Removing\u2026") : "Remove";
    const refuse = plugPlaceReady(held.place);
    if (refuse) {
      btn.disabled = true;
      btn.title = refuse;
    } else if (plugState.busy) {
      btn.disabled = true;
      btn.title = plugState.busy.name + " is " + plugBusyWord(plugState.busy);
    } else {
      btn.title = `remove ${held.name} ${version} from ${plugPlace(held)} \u2014 the versions beside it stay`;
    }
    btn.addEventListener("click", () => plugRemoveVersion(held, record));
    return btn;
  }
  function plugInstallButton(entry) {
    const held = plugState.held ? plugState.held.find((h) => h.name === entry.name) : null;
    const offered = String(entry.version || "");
    const heldRelease = held ? String(held.version || "").split("+")[0] : "";
    const same = Boolean(held) && heldRelease === offered;
    const newer = Boolean(held) && !same;
    const busy2 = plugState.busy && plugState.busy.name === entry.name;
    const where = plugPlaceName(entry);
    const btn = document.createElement("button");
    btn.className = "plug-install";
    btn.type = "button";
    btn.textContent = busy2 ? plugBusyLabel(plugState.busy, "Installing\u2026") : same ? "Reinstall" : newer ? "Update" : "Install";
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
      btn.title = `put ${entry.name} ${offered} on ${where} \u2014 it holds ${held.version}, a record from before installs carried a version: ${offered}+${digest} replaces it, and the old directory is deleted, not kept`;
    } else if (newer) {
      btn.title = `put ${entry.name} ${offered} on ${where} \u2014 it holds ${held.version} now, and the older one is replaced, not kept`;
    } else if (plugHeldError(entry.place)) {
      btn.title = `what ${where} holds could not be read; the host still decides`;
    } else {
      btn.title = `install ${entry.name} on ${where}`;
    }
    btn.addEventListener("click", () => plugInstall(entry));
    return btn;
  }
  function plugStageLine(busy2) {
    const where = plugPlaceName(busy2);
    if (busy2.verb === "remove") return `removing ${busy2.name}${busy2.version ? " " + busy2.version : ""} from ${where}\u2026`;
    if (busy2.verb === "disable") return `stopping ${busy2.name} on ${where}\u2026`;
    if (busy2.verb === "enable") return `driving ${busy2.name} on ${where} again\u2026`;
    switch (busy2.stage) {
      case "wake":
        return `${where} is starting its supervisor\u2026`;
      case "copy":
        return `bringing ${busy2.name} ${busy2.version || ""} onto ${where}\u2026`.replace("  ", " ");
      case "artifact":
        return `preparing the bytes for ${busy2.name}\u2026`;
      case "upload":
        return `sending ${busy2.name} ${busy2.version || ""} to ${where}\u2026`.replace("  ", " ");
      case "fetch":
        return `${where} is fetching ${busy2.name} ${busy2.version || ""}\u2026`.replace("  ", " ");
      case "mirror":
        return `${where} could not reach the release host \u2014 trying ${busy2.prefix || "a mirror"} instead\u2026`;
      case "current":
        return `${busy2.name} is already current on ${where} \u2014 nothing was sent`;
      case "installed":
        return `${busy2.name} landed on ${where}`;
      default:
        return `installing ${busy2.name} on ${where}\u2026`;
    }
  }
  function plugInstallResult(entry, res, where) {
    if (!res || !res.ok) {
      return { ok: false, name: entry.name, text: `could not install ${entry.name} on ${where} \u2014 ${res && res.error || "no answer"}` };
    }
    if (res.status === "current") {
      return { ok: true, name: entry.name, text: `${entry.name} was already current (${res.version}) on ${where} \u2014 nothing was sent` };
    }
    const path = res.path ? " \xB7 " + res.path : "";
    const via = res.via ? ` \xB7 via ${res.via}` : "";
    return { ok: true, name: entry.name, text: `installed ${entry.name} ${res.version} on ${where}${via}${path}` };
  }
  function plugRemoveResult(held, res, where) {
    if (!res || !res.ok) {
      return { ok: false, name: held.name, text: `could not remove ${held.name} from ${where} \u2014 ${res && res.error || "no answer"}` };
    }
    if (res.status === "absent") {
      return { ok: true, name: held.name, text: `${held.name} was not installed on ${where} \u2014 there was nothing to remove` };
    }
    const went = res.removed && res.removed.length ? " " + res.removed.join(", ") : "";
    return { ok: true, name: held.name, text: `removed ${held.name}${went} from ${where}` };
  }
  function plugSwitchResult(held, res, where) {
    if (!res || !res.ok) {
      return { ok: false, name: held.name, text: `could not switch ${held.name} on ${where} \u2014 ${res && res.error || "no answer"}` };
    }
    if (res.status === "absent") {
      return { ok: true, name: held.name, text: `${held.name} is not held by ${where} \u2014 there was nothing to stop or start` };
    }
    const now = typeof res.disabled === "boolean" ? res.disabled : !held.disabled;
    return {
      ok: true,
      name: held.name,
      text: now ? `stopped driving ${held.name} on ${where} \u2014 it is still held there, its tools are no longer offered` : `driving ${held.name} on ${where} again \u2014 its tools are offered once more`
    };
  }
  async function plugRemove(held) {
    const api = window.clutchComponents;
    if (!api || !api.remove || plugState.busy || plugPlaceReady(held.place)) return;
    const where = plugPlace(held);
    const version = held.version ? " " + held.version : "";
    const go = await askConfirm({
      title: `Remove ${held.name}?`,
      text: `${held.name}${version} is deleted from the component directory on ${where}, together with any other version of it held there. This cannot be undone from here: nothing in this app keeps a copy of what it removes, so putting it back means installing it again from a source.`,
      ok: "Remove"
    });
    if (!go) return;
    plugState.busy = { name: held.name, verb: "remove", stage: "removing", place: held.place };
    plugState.result = null;
    renderPlugins();
    let res;
    try {
      res = await api.remove(held.name);
    } catch (e) {
      res = { ok: false, name: held.name, error: e && e.message || String(e) };
    }
    plugState.busy = null;
    plugState.result = plugRemoveResult(held, res, where);
    renderPlugins();
    if (res && res.ok) {
      plugRead();
      plugRefreshVersions();
    }
  }
  async function plugRemoveVersion(held, record) {
    const api = window.clutchComponents;
    if (!api || !api.remove || plugState.busy || plugPlaceReady(held.place)) return;
    const where = plugPlace(held);
    const version = String(record.version || "");
    const go = await askConfirm({
      title: `Remove ${held.name} ${version}?`,
      text: `${held.name} ${version} is deleted from the component directory on ${where} \u2014 exactly the version named; the versions beside it stay. This cannot be undone from here: nothing in this app keeps a copy of what it removes, so putting it back means installing it again from a source.`,
      ok: "Remove"
    });
    if (!go) return;
    plugState.busy = { name: held.name, verb: "remove", stage: "removing", version, place: held.place };
    plugState.result = null;
    renderPlugins();
    let res;
    try {
      res = await api.remove(held.name, { version });
    } catch (e) {
      res = { ok: false, name: held.name, error: e && e.message || String(e) };
    }
    plugState.busy = null;
    plugState.result = plugRemoveResult(held, res, where);
    renderPlugins();
    if (res && res.ok) {
      plugRead();
      plugRefreshVersions();
    }
  }
  function plugReadVersions(name) {
    const api = window.clutchComponents;
    if (!api || !api.versions) return;
    const seq = ++plugState.versionsSeq;
    plugState.versionsPending = name;
    renderPlugins();
    let out;
    Promise.resolve().then(() => api.versions(name)).then((r) => {
      out = { name, rows: r && Array.isArray(r.versions) ? r.versions : [], error: r && r.error || null };
    }).catch((e) => {
      out = { name, rows: [], error: e && e.message || String(e) };
    }).then(() => {
      if (seq !== plugState.versionsSeq) return;
      plugState.versionsPending = null;
      plugState.versions = out;
      renderPlugins();
    });
  }
  function plugVersionsToggle(held) {
    if (plugState.versionsPending === held.name) return;
    if (plugState.versions && plugState.versions.name === held.name) {
      plugState.versions = null;
      plugState.versionsSeq++;
      renderPlugins();
      return;
    }
    plugReadVersions(held.name);
  }
  function plugRefreshVersions() {
    const name = plugState.versions && plugState.versions.name || plugState.versionsPending;
    if (name) plugReadVersions(name);
  }
  async function plugSwitch(held) {
    const api = window.clutchComponents;
    if (!api || !api.setDisabled || plugState.busy || plugPlaceReady(held.place)) return;
    const where = plugPlace(held);
    const disabled = !held.disabled;
    plugState.busy = { name: held.name, verb: disabled ? "disable" : "enable", stage: "starting", place: held.place };
    plugState.result = null;
    renderPlugins();
    let res;
    try {
      res = await api.setDisabled(held.name, disabled);
    } catch (e) {
      res = { ok: false, name: held.name, error: e && e.message || String(e) };
    }
    plugState.busy = null;
    plugState.result = plugSwitchResult(held, res, where);
    renderPlugins();
    if (res && res.ok) {
      plugRead();
      plugRefreshVersions();
    }
  }
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
      res = { ok: false, error: e && e.message || String(e) };
    }
    plugState.mirrorBusy = false;
    if (res && res.ok) {
      plugState.mirrors = res.mirrors || [];
      plugState.mirrorsError = res.error || null;
      plugState.mirrorDraft = "";
      plugState.mirrorResult = { ok: true, text: `${raw} is in your list: it is tried before the entries this build ships` };
    } else {
      plugState.mirrorResult = { ok: false, text: res && res.error || "no answer" };
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
      res = { ok: false, error: e && e.message || String(e) };
    }
    plugState.mirrorBusy = false;
    if (res && res.ok) {
      plugState.mirrors = res.mirrors || [];
      plugState.mirrorsError = res.error || null;
      plugState.mirrorResult = { ok: true, text: `${url} is no longer tried` };
    } else {
      plugState.mirrorResult = { ok: false, text: res && res.error || "no answer" };
    }
    renderPlugins();
  }
  async function plugInstall(entry) {
    const api = window.clutchComponents;
    if (!api || plugState.busy || entry.problem) return;
    if (!plugPlaceUnread(entry) && plugPlaceReady(entry.place)) return;
    const where = plugPlaceName(entry);
    const held = plugState.held ? plugState.held.find((h) => h.name === entry.name) : null;
    const read = plugPlaceUnread(entry) ? "" : plugPlaceUnknown(entry.place);
    const knows = read ? ` Whether ${where} already holds it could not be read.` : "";
    const again = held ? ` It already holds ${held.version}; installing rewrites that same version.` : "";
    const go = await askConfirm({
      title: `Install ${entry.name}?`,
      text: `${entry.name}${entry.version ? " " + entry.version : ""} is written into the component directory on ${where}. It can be removed again from this page, but a removal DELETES bytes: nothing here keeps a copy, so neither act is a rollback.` + again + knows,
      ok: "Install"
    });
    if (!go) return;
    plugState.busy = { name: entry.name, stage: "starting", place: entry.place };
    plugState.result = null;
    renderPlugins();
    let res;
    try {
      res = await api.install(entry.name);
    } catch (e) {
      res = { ok: false, name: entry.name, error: e && e.message || String(e) };
    }
    plugState.busy = null;
    plugState.result = plugInstallResult(entry, res, res && res.place ? plugPlace({ place: res.place }) : where);
    renderPlugins();
    if (res && res.ok) {
      plugRead();
      plugRefreshVersions();
    }
  }
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
    plugBodyEl.innerHTML = "";
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
      note = "reading\u2026";
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
    if (window.clutchComponents.mirrors) plugBodyEl.appendChild(plugMirrors());
  }
  function plugRead({ force = false } = {}) {
    const api = window.clutchComponents;
    if (!api || plugState.pending) return;
    plugState.sessionError = null;
    plugState.sessionHeldError = null;
    plugState.clientError = null;
    plugState.clientHeldError = null;
    plugState.marketError = null;
    plugState.mirrorsError = null;
    const mirrors = api.mirrors ? api.mirrors() : null;
    plugState.pending = mirrors ? 3 : 2;
    renderPlugins();
    api.list().then((r) => {
      plugState.sessionBase = r.sessionBase || "";
      plugState.sessionError = r.error || null;
      plugState.sessionHeldError = r.inventoryError || null;
      plugState.client = Boolean(r.client);
      plugState.clientError = r.clientError || null;
      plugState.clientHeldError = r.clientInventoryError || null;
      plugState.held = Array.isArray(r.held) ? r.held : [];
      plugState.pass = r.pass || null;
      plugState.read = true;
    }).catch((e) => {
      plugState.sessionError = e && e.message || String(e);
      plugState.read = true;
    }).then(() => {
      plugState.pending--;
      renderPlugins();
    });
    api.market({ force }).then((m) => {
      plugState.market = m;
    }).catch((e) => {
      plugState.marketError = e && e.message || String(e);
    }).then(() => {
      plugState.pending--;
      renderPlugins();
    });
    if (mirrors) {
      mirrors.then((m) => {
        plugState.mirrors = m && m.mirrors || [];
        plugState.mirrorsError = m && m.error || null;
        plugState.mirrorForced = m && m.forced || "";
      }).catch((e) => {
        plugState.mirrors = null;
        plugState.mirrorsError = e && e.message || String(e);
      }).then(() => {
        plugState.pending--;
        renderPlugins();
      });
    }
  }
  function plugMirrorStored() {
    try {
      return localStorage.getItem("clutch_source_mirror") || "";
    } catch (e) {
      return "";
    }
  }
  function plugMirrorNote(text, bad) {
    if (!plugMirrorNoteEl) return;
    plugMirrorNoteEl.className = "plug-mirror-note" + (bad ? " error" : "");
    plugMirrorNoteEl.textContent = text;
  }
  function plugMirrorIdleNote() {
    const cur = plugMirrorStored();
    plugMirrorNote(
      cur ? `the market index and every manifest are read under ${cur}` : "no mirror: the market index and every manifest are read from github.com",
      false
    );
  }
  async function plugMirrorSave() {
    const raw = plugMirrorInput ? plugMirrorInput.value.trim() : "";
    if (raw && !/^https?:\/\//i.test(raw)) {
      plugMirrorNote(
        `"${raw}" is not http(s): a mirror is the prefix a source URL is read under, so it has to be a URL too \u2014 nothing was written`,
        true
      );
      return;
    }
    const value = raw.replace(/\/+$/, "");
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
      reply = { ok: false, error: e && e.message || String(e) };
    }
    if (plugMirrorSaveBtn) plugMirrorSaveBtn.disabled = false;
    if (reply && reply.ok === false) {
      plugMirrorNote(`could not save the mirror: ${reply && reply.error || "the host refused it"}`, true);
      return;
    }
    try {
      localStorage.setItem("clutch_source_mirror", value);
    } catch (e) {
    }
    plugMirrorNote(
      value ? `the market index and every manifest are now read under ${value} \u2014 every digest is still checked against the release's own pin` : "no mirror: the market index and every manifest are read from github.com again",
      false
    );
    plugState.result = null;
    plugRead({ force: true });
  }
  if (plugMirrorInput) plugMirrorInput.value = plugMirrorStored();
  if (plugMirrorSaveBtn) plugMirrorSaveBtn.addEventListener("click", plugMirrorSave);
  plugMirrorIdleNote();
  plugReloadBtn.addEventListener("click", () => {
    plugState.result = null;
    plugRead({ force: true });
  });
  $("#settings-tab-plugins").addEventListener("click", () => pluginTabShown());
  function pluginTabShown() {
    plugRead();
  }
  function plugPaneVisible() {
    const pane2 = $("#settings-pane-plugins");
    const box = $("#settings-modal");
    if (!pane2 || !box) return false;
    return !pane2.classList.contains("hidden") && !box.classList.contains("hidden");
  }
  if (window.clutchApi && window.clutchApi.onBaseChanged) {
    window.clutchApi.onBaseChanged(() => {
      if (!plugPaneVisible()) return;
      plugState.result = null;
      plugRead();
    });
  }
  if (window.clutchTunnel && window.clutchTunnel.onEnd) {
    window.clutchTunnel.onEnd(() => {
      if (!plugPaneVisible()) return;
      plugState.result = null;
      plugRead();
    });
  }
  if (window.clutchComponents && window.clutchComponents.onProgress) {
    window.clutchComponents.onProgress((stage) => {
      if (!stage || !plugState.busy || stage.name !== plugState.busy.name) return;
      plugState.busy = {
        name: stage.name,
        stage: stage.stage,
        version: stage.version,
        prefix: stage.prefix || "",
        place: plugState.busy.place,
        verb: plugState.busy.verb
      };
      renderPlugins();
    });
  }

  // src/renderer/status-bar.ts
  var sbStatus = $("#sb-status");
  var sbBackend = $("#sb-backend");
  var sbModel = $("#sb-model");
  var sbProject = $("#sb-project");
  function paintStatus(s) {
    sbStatus.textContent = s || "idle";
    sbStatus.className = "sb-item sb-status " + (s || "idle");
  }
  document.addEventListener("clutch:status-changed", (ev) => {
    paintStatus(ev.detail);
  });
  function hostPort(base) {
    if (!base) return "\u2014";
    try {
      const u = new URL(base);
      return u.host;
    } catch {
      return base.replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 40);
    }
  }
  function paintBackend(base) {
    const label = hostPort(base);
    sbBackend.textContent = label;
    sbBackend.title = base || "no backend";
  }
  document.addEventListener("clutch:backend-changed", (ev) => {
    paintBackend(ev.detail);
  });
  function readActiveModel() {
    const active = localStorage.getItem("clutch_llm_active");
    if (!active) return "";
    const p = llmProfiles()[active];
    return p && p.model || "";
  }
  function paintModel() {
    const m = readActiveModel();
    sbModel.textContent = m || "\u2014";
    sbModel.title = m ? "model: " + m : "no model configured";
  }
  document.addEventListener("clutch:settings-saved", paintModel);
  window.addEventListener("storage", (ev) => {
    if (ev.key === "clutch_llm_profiles" || ev.key === "clutch_llm_active") paintModel();
  });
  function paintProject(path, name) {
    if (!path) {
      sbProject.textContent = "\u2014";
      sbProject.title = "no project open";
      return;
    }
    sbProject.textContent = name || path.split(/[/\\]/).pop() || path;
    sbProject.title = path;
  }
  document.addEventListener("clutch:project-info", (ev) => {
    const d = ev.detail || {};
    paintProject(d.project || "", d.name || "");
  });
  paintStatus("idle");
  paintModel();
  paintProject("", "");

  // src/renderer/commands.ts
  var registry = /* @__PURE__ */ new Map();
  var listeners2 = /* @__PURE__ */ new Set();
  function register(def) {
    registry.set(def.id, def);
  }
  function execute(id, arg) {
    const cmd = registry.get(id);
    if (!cmd) return false;
    try {
      if (cmd.enabled && !cmd.enabled()) return false;
    } catch (e) {
      return false;
    }
    try {
      const out = cmd.run(arg);
      if (out && typeof out.catch === "function") out.catch((e) => console.warn("[command] " + id, e));
    } catch (e) {
      console.warn("[command] " + id, e);
    }
    return true;
  }
  function isEnabled(id) {
    const cmd = registry.get(id);
    if (!cmd) return false;
    try {
      return !cmd.enabled || !!cmd.enabled();
    } catch (e) {
      return false;
    }
  }
  function has(id) {
    return registry.has(id);
  }
  function onChange(cb) {
    listeners2.add(cb);
  }
  function matches(e, spec) {
    const parts = spec.toLowerCase().split("+");
    const key = parts.pop() || "";
    const needMod = parts.includes("mod") || parts.includes("ctrl");
    const needShift = parts.includes("shift");
    const needAlt = parts.includes("alt");
    const mod = e.ctrlKey || e.metaKey;
    if (needMod !== mod) return false;
    if (needShift !== e.shiftKey) return false;
    if (needAlt !== e.altKey) return false;
    return (e.key || "").toLowerCase() === key;
  }
  var bound = false;
  function bindKeys() {
    if (bound) return;
    bound = true;
    document.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      for (const cmd of registry.values()) {
        if (!cmd.key || !matches(e, cmd.key)) continue;
        if (cmd.enabled && !cmd.enabled()) continue;
        e.preventDefault();
        execute(cmd.id);
        return;
      }
    });
  }

  // src/renderer/tab-bar.ts
  var LS_KEY = "clutch_tabs";
  function saveTabs() {
    try {
      const tabs = state.tabs.map((t) => ({
        id: t.id,
        path: t.path,
        name: t.name,
        // undefined (never recorded) is dropped by JSON.stringify: the next load
        // reads it back as undefined, which is exactly "still unknown"
        machine: t.machine
      }));
      localStorage.setItem(LS_KEY, JSON.stringify({ tabs, activeTabId: state.activeTabId || "" }));
    } catch (e) {
    }
  }
  function loadTabs() {
    let raw;
    try {
      raw = localStorage.getItem(LS_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;
    let data;
    try {
      data = JSON.parse(raw);
      if (!data || typeof data !== "object") throw new Error("it is not a tab store");
    } catch (e) {
      corruptRecord("remembered tabs", LS_KEY, e);
      return;
    }
    if (Array.isArray(data.tabs)) {
      const seenId = /* @__PURE__ */ new Set();
      const seenPath = /* @__PURE__ */ new Set();
      state.tabs = data.tabs.filter((t) => t && typeof t.id === "string" && typeof t.path === "string").filter((t) => {
        if (!t.id || seenId.has(t.id) || !t.path || seenPath.has(t.path)) return false;
        seenId.add(t.id);
        seenPath.add(t.path);
        return true;
      }).map((t) => ({
        id: t.id,
        path: t.path,
        name: typeof t.name === "string" ? t.name : t.path.split("/").pop() || t.path,
        // undefined for a store written before the field existed: unknown, and
        // the claim then follows whatever the window is on (with the open's
        // own self-heal, project.ts, as the backstop)
        machine: asMachine(t.machine),
        base: null,
        running: false,
        needsInput: false
      }));
    }
    const active = typeof data.activeTabId === "string" ? data.activeTabId : "";
    state.activeTabId = state.tabs.some((t) => t.id === active) ? active : null;
  }
  var mru = [];
  var closedStack = [];
  var draggingId = null;
  function noteMru(id) {
    mru = [id, ...mru.filter((x) => x !== id)];
    if (mru.length > 50) mru.length = 50;
  }
  function closedTabCount() {
    return closedStack.length;
  }
  function tabMarkState(tab) {
    if (tab.needsInput) return "ask";
    if (tab.running) return "run";
    return null;
  }
  function renderTabBar() {
    const bar2 = document.getElementById("tab-bar");
    if (!bar2) return;
    const newBtn = document.getElementById("tab-new-btn");
    Array.from(bar2.querySelectorAll(".doc-tab")).forEach((el) => el.remove());
    bar2.classList.toggle("hidden", state.tabs.length === 0);
    for (const tab of state.tabs) {
      const el = document.createElement("div");
      const mark = tabMarkState(tab);
      el.className = "doc-tab" + (tab.id === state.activeTabId ? " active" : "") + (tab.running ? " running" : "");
      el.dataset.tabId = tab.id;
      el.tabIndex = 0;
      el.draggable = true;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", tab.id === state.activeTabId ? "true" : "false");
      el.title = tab.path + (mark === "ask" ? "\nwaiting for your answer" : mark === "run" ? "\nrunning" : "");
      el.setAttribute(
        "aria-label",
        tab.name + (mark === "ask" ? " \u2014 waiting for input" : mark === "run" ? " \u2014 running" : "")
      );
      const label = document.createElement("span");
      label.className = "doc-tab-label";
      label.textContent = tab.name;
      el.appendChild(label);
      if (mark) {
        const dot = document.createElement("span");
        dot.className = "doc-tab-dot doc-tab-dot-" + mark;
        dot.setAttribute("aria-hidden", "true");
        el.appendChild(dot);
      }
      const closeBtn = document.createElement("button");
      closeBtn.className = "doc-tab-close";
      closeBtn.setAttribute("aria-label", `Close ${tab.name}`);
      closeBtn.textContent = "\u2715";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        tabClose(tab.id);
      });
      el.appendChild(closeBtn);
      el.addEventListener("click", () => tabActivate(tab.id));
      el.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        tabClose(tab.id);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const idx = state.tabs.findIndex((t) => t.id === tab.id);
        if (idx < 0) return;
        const next = state.tabs[(idx + (e.key === "ArrowRight" ? 1 : -1) + state.tabs.length) % state.tabs.length];
        if (next) tabActivate(next.id);
      });
      el.addEventListener("dragstart", (e) => {
        draggingId = tab.id;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          try {
            e.dataTransfer.setData("text/plain", tab.id);
          } catch (err) {
          }
        }
      });
      el.addEventListener("dragover", (e) => {
        if (draggingId && draggingId !== tab.id) e.preventDefault();
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = state.tabs.findIndex((t) => t.id === draggingId);
        const to = state.tabs.findIndex((t) => t.id === tab.id);
        draggingId = null;
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = state.tabs.splice(from, 1);
        state.tabs.splice(to, 0, moved);
        saveTabs();
        renderTabBar();
      });
      el.addEventListener("dragend", () => {
        draggingId = null;
      });
      if (newBtn) bar2.insertBefore(el, newBtn);
      else bar2.appendChild(el);
    }
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    document.title = active ? `${active.running ? "\u25CF " : ""}${active.name} \u2014 Clutch` : "Clutch";
  }
  function tabOpen(path, name) {
    if (!path) return;
    let tab = findTabByPath(path);
    if (!tab) {
      tab = ensureTab(path, name);
    } else if (name) {
      tab.name = name;
    }
    tab.path = path;
    tab.projectKey = path;
    state.activeTabId = tab.id;
    noteMru(tab.id);
    renderTabBar();
    saveTabs();
  }
  async function tabClose(id) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = state.tabs[idx];
    const running = !!tab.running || tab.id === state.activeTabId && busy;
    if (running) {
      const yes = await askConfirm({
        title: "Stop this task and close the tab?",
        text: `${tab.name} is still running.
Closing its tab stops the task and writes an aborted ending to the project log.`,
        ok: "Stop and close",
        cancel: "Keep it"
      });
      if (!yes) return;
      if (window.clutchRun && window.clutchRun.stop) {
        try {
          await window.clutchRun.stop(tab.id);
        } catch (e) {
        }
      }
    }
    unwatchTab(id);
    await releaseTab(tab);
    forgetMemento(id);
    forgetDomCache(id);
    state.tabs.splice(idx, 1);
    if (tab.path) {
      closedStack.push({ path: tab.path, name: tab.name });
      if (closedStack.length > 20) closedStack.shift();
    }
    mru = mru.filter((x) => x !== id);
    const wasActive = state.activeTabId === id;
    if (wasActive) state.activeTabId = null;
    renderTabBar();
    saveTabs();
    if (!wasActive) return;
    const next = state.tabs[idx] ?? state.tabs[idx - 1] ?? null;
    if (next) {
      await tabActivate(next.id);
    } else {
      showWelcome();
    }
  }
  async function tabActivate(id) {
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return;
    noteMru(tab.id);
    await activateTab(tab);
    saveTabs();
  }
  async function tabCloseOthers() {
    const keep = state.activeTabId;
    for (const t of [...state.tabs]) {
      if (keep && t.id === keep) continue;
      await tabClose(t.id);
    }
  }
  async function tabCloseAll() {
    for (const t of [...state.tabs]) await tabClose(t.id);
  }
  async function tabReopen() {
    const last = closedStack.pop();
    if (!last) return;
    const tab = ensureTab(last.path, last.name);
    await tabActivate(tab.id);
  }
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.key !== "Tab" || state.tabs.length < 2) return;
    e.preventDefault();
    if (!e.shiftKey) {
      const prior = mru.find((id) => id !== state.activeTabId && state.tabs.some((t) => t.id === id));
      if (prior) tabActivate(prior);
      return;
    }
    const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
    if (idx < 0) return;
    const len = state.tabs.length;
    const next = state.tabs[(idx - 1 + len) % len];
    tabActivate(next.id);
  });
  document.getElementById("tab-new-btn")?.addEventListener("click", () => {
    execute("tab-new");
  });
  document.addEventListener("clutch:project-info", (ev) => {
    const { project, name } = ev.detail ?? {};
    if (project) tabOpen(project, name || project.split("/").pop() || project);
  });
  document.addEventListener("clutch:tab-state", () => renderTabBar());
  onTabsPersist(saveTabs);
  loadTabs();
  renderTabBar();

  // src/renderer/titlebar.ts
  var menu = $("#tb-menu");
  var openItem = null;
  var hasProject = () => !!currentProject;
  var tabCount = () => state.tabs.length;
  var activeId = () => state.activeTabId || "";
  var activeRunning = () => !!busy;
  function closeMenu() {
    if (!openItem) return;
    openItem.classList.remove("open");
    openItem = null;
  }
  register({ id: "open", key: "mod+o", run: () => openFsBrowser("open") });
  register({ id: "new", key: "mod+n", run: () => openFsBrowser("new") });
  register({ id: "settings", run: () => openSettings() });
  register({ id: "about", run: () => openSettings().then(() => showSettingsTab("about")) });
  register({ id: "run", enabled: () => hasProject() && !activeRunning(), run: () => run() });
  register({ id: "stop", enabled: () => activeRunning(), run: () => stop() });
  register({ id: "mode-work", run: () => setMode("work") });
  register({ id: "mode-chat", run: () => setMode("chat") });
  register({ id: "trust", run: () => setTrustArmed(!trustArmed()) });
  register({
    id: "toggle-right",
    // desktop: collapse/show the aside; phone: the aside IS the drawer
    run: () => {
      if (NARROW_Q.matches) setShellPanel(!shellPanel.classList.contains("drawer-open"));
      else shellPanel.classList.toggle("panel-hidden");
    }
  });
  register({ id: "toggle-statusbar", run: () => $("#statusbar")?.classList.toggle("hidden") });
  register({ id: "toggle-hidden", run: () => toggleHidden() });
  register({ id: "tab-new", run: () => openFsBrowser("open") });
  register({ id: "tab-close", key: "mod+w", enabled: () => tabCount() > 0, run: () => tabClose(activeId()) });
  register({ id: "tab-close-others", enabled: () => tabCount() > 1, run: () => tabCloseOthers() });
  register({ id: "tab-close-all", enabled: () => tabCount() > 0, run: () => tabCloseAll() });
  register({ id: "tab-reopen", key: "mod+shift+t", enabled: () => closedTabCount() > 0, run: () => tabReopen() });
  register({ id: "activate-tab", run: ({ tab }) => tab && tabActivate(tab) });
  register({ id: "open-recent", run: ({ path }) => path && openProject(path) });
  var RECENT_KEY = "clutch_recent";
  function recentList() {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    let list;
    try {
      list = JSON.parse(raw);
      if (!Array.isArray(list)) throw new Error("it is not a list of projects");
    } catch (e) {
      corruptRecord("recent-project list", RECENT_KEY, e);
      return [];
    }
    return list.filter((r) => r && typeof r.path === "string");
  }
  function recordRecent(project, name) {
    if (!project) return;
    const list = recentList().filter((r) => r.path !== project);
    list.unshift({ path: project, name: name || project.split("/").pop() || project });
    if (list.length > 8) list.length = 8;
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch (e) {
    }
  }
  function ddItem(action, text, attrs = {}) {
    const el = document.createElement("div");
    el.className = "tb-dd-item";
    el.dataset.action = action;
    el.textContent = text;
    for (const [k, v] of Object.entries(attrs)) el.dataset[k] = v;
    return el;
  }
  function renderRecent() {
    const box = document.getElementById("tb-recent");
    if (!box) return;
    box.textContent = "";
    const list = recentList();
    if (!list.length) {
      const empty = ddItem("", "No recent projects");
      empty.classList.add("disabled");
      box.appendChild(empty);
      return;
    }
    for (const r of list) {
      const item = ddItem("open-recent", r.name || r.path, { path: r.path });
      item.title = r.path;
      box.appendChild(item);
    }
  }
  function renderOpenTabs() {
    const box = document.getElementById("tb-tabs");
    if (!box) return;
    box.textContent = "";
    if (!state.tabs.length) {
      const empty = ddItem("", "No open tabs");
      empty.classList.add("disabled");
      box.appendChild(empty);
      return;
    }
    for (const tab of state.tabs) {
      const mark = tab.id === state.activeTabId ? "\u2713 " : "";
      const tabState = tabMarkState(tab);
      const dot = tabState === "ask" ? "  \u25CF" : tabState === "run" ? "  \u25D0" : "";
      const item = ddItem("activate-tab", mark + tab.name + dot, { tab: tab.id });
      item.title = tab.path;
      if (tab.id === state.activeTabId) item.classList.add("active-tab");
      box.appendChild(item);
    }
  }
  function refreshMenu() {
    menu?.querySelectorAll("[data-action]").forEach((el) => {
      const id = el.dataset.action || "";
      if (!id || !has(id)) return;
      el.classList.toggle("disabled", !isEnabled(id));
    });
    renderRecent();
    renderOpenTabs();
  }
  menu?.addEventListener("click", (e) => {
    const target = e.target;
    const action = target.closest("[data-action]");
    if (action && action.dataset.action) {
      e.stopPropagation();
      if (action.classList.contains("disabled")) return;
      closeMenu();
      execute(action.dataset.action, { path: action.dataset.path, tab: action.dataset.tab });
      return;
    }
    const item = target.closest(".tb-menu-item");
    if (!item) return;
    if (item === openItem) {
      closeMenu();
      return;
    }
    closeMenu();
    item.classList.add("open");
    openItem = item;
    refreshMenu();
  });
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target || !target.closest("#tb-menu")) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
  document.addEventListener("clutch:project-info", (ev) => {
    const { project, name } = ev.detail ?? {};
    recordRecent(project, name);
    refreshMenu();
  });
  document.addEventListener("clutch:tab-state", () => refreshMenu());
  document.addEventListener("clutch:status-changed", () => refreshMenu());
  document.addEventListener("clutch:backend-changed", () => refreshMenu());
  onChange(refreshMenu);
  bindKeys();
  refreshMenu();

  // src/renderer/boot.ts
  onTabAutoConnect(connectTabMachine);
  function storedLlmConfig() {
    const active = localStorage.getItem("clutch_llm_active");
    const p = active ? llmProfiles()[active] : null;
    if (p && (p.base_url || p.model || p.api_key)) {
      return {
        base_url: p.base_url || "",
        model: p.model || "",
        api_key: p.api_key || "",
        reasoning_effort: p.reasoning_effort || "",
        api_protocol: p.api_protocol || ""
      };
    }
    const key = localStorage.getItem("clutch_api_key") || "";
    const legacyRaw = localStorage.getItem("clutch_llm");
    if (legacyRaw) {
      let legacy = null;
      try {
        legacy = JSON.parse(legacyRaw);
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
          api_protocol: ""
        };
      }
    }
    return null;
  }
  function healSettingsMirror() {
    const cfg = storedLlmConfig();
    if (!cfg) return;
    if (!(window.clutchSettings && window.clutchSettings.ensure)) return;
    const failed = (why) => notice("Could not rebuild ~/.clutch/settings.json: " + why);
    window.clutchSettings.ensure(cfg).then((r) => {
      if (r && r.ok === false) failed(r.error || "the host refused it");
    }, (e) => failed(e && e.message || String(e)));
  }
  async function loadHostDefaults() {
    try {
      const data = await apiFetch("/api/host");
      if (data && data.ui) state.hostUiDefaults = data.ui;
    } catch (e) {
      notice("The host did not describe its UI defaults (" + (e && e.message || e) + "); rows are drawn with this build's own, which may not be what it serves.", "info");
    }
  }
  (async () => {
    const restoredTabs = state.tabs.length > 0 && !connLostExitPending();
    if (!restoredTabs) {
      if (state.activeTabId) {
        state.activeTabId = null;
        document.dispatchEvent(new CustomEvent("clutch:tab-state"));
      }
      await resolveApiBase();
    }
    const bootTab = restoredTabs ? state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0] : null;
    if (bootTab) {
      beginPaneLoad(bootTab);
      const base = await claimTab(bootTab);
      if (base) adoptBase(base);
      else if (bootTab.unreachable) notice(bootTab.unreachable, "info");
    }
    await loadHostDefaults();
    healSettingsMirror();
    if (restoredTabs) {
      if (!bootTab || !state.apiBase) {
        state.activeTabId = null;
        document.dispatchEvent(new CustomEvent("clutch:tab-state"));
        showWelcome();
        return;
      }
      await tabActivate(bootTab.id);
      if (!state.apiBase) {
        state.activeTabId = null;
        document.dispatchEvent(new CustomEvent("clutch:tab-state"));
        showWelcome();
      }
      return;
    }
    const url = await reconciledBackendUrl();
    if (url) switchBackend(url);
    connectSSE();
    resumeTurn();
  })();
  if (typeof window.clutchWin !== "undefined") {
    const cw = window.clutchWin;
    document.querySelector(".tb-winbtn.minimize")?.addEventListener("click", () => cw.minimize());
    document.querySelector(".tb-winbtn.maximize")?.addEventListener("click", () => cw.maximize());
    document.querySelector(".tb-winbtn.close")?.addEventListener("click", () => cw.close());
  }
})();
