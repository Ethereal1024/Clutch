// Bridge shim (R4): the window.clutch* API of ui/preload.js without Electron.
// Runs inside any browser/WebView (Android WebView, a plain dev browser);
// every method call becomes a POST to the host's loopback bridge endpoint and
// every event a subscription on its single SSE stream. Method names, arities,
// argument shapes and error semantics mirror preload.js exactly — that parity
// is asserted by tests/bridge-shim.test.js, keep both sides in sync.
//
// Endpoint resolution (first hit wins):
//   1. window.CLUTCH_BRIDGE_BASE            — set by the embedding shell
//   2. ?bridge= on this script's URL        — <script src="bridge-shim.js?bridge=http://127.0.0.1:PORT/">
//   3. default                              — http://127.0.0.1:8899/
//
// Wire protocol (implemented by the host's bridge server, e.g. android/host/bridge-server.js):
//   POST {base}api/<ns>/<method>   body: JSON array of args
//       -> { ok: true, result: ... } | { ok: false, error: "..." }  (error => the promise rejects,
//          matching ipcRenderer.invoke's rejection when a main-process handler throws)
//   GET  {base}events              text/event-stream; each message data is JSON {event, args}
//       carrying the IPC channel names ("backend:base-changed", "tunnel:progress", "tunnel:ended")
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;

  // Electron preload owns the bridge when it ran (contextBridge already put
  // window.clutch* in place) — the shim only fills a non-Electron page, it
  // must never shadow the real IPC API. index.html therefore includes this
  // file unconditionally and the guard makes it inert under Electron.
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
      /* no document (tests) or a bogus URL: fall through to the default */
    }
    return "http://127.0.0.1:8899/";
  }
  const base = resolveBase();

  async function call(ns, method, args) {
    let r, d;
    try {
      r = await fetch(base + "api/" + ns + "/" + method, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args || []),
      });
      d = await r.json();
    } catch (e) {
      // unreachable bridge == a dead IPC channel: nothing sensible to resolve with
      throw new Error("bridge unreachable (" + ns + "." + method + "): " + ((e && e.message) || e));
    }
    if (!d || d.ok !== true) {
      throw new Error((d && d.error) || "bridge call failed: " + ns + "." + method);
    }
    return d.result;
  }

  // one shared EventSource multiplexes every channel; listeners come and go
  // per subscription, the stream itself stays up until the page goes away
  const listeners = new Map(); // channel -> Set<cb>
  let stream = null;
  function ensureStream() {
    if (stream) return;
    stream = new EventSource(base + "events");
    stream.onmessage = (m) => {
      let d;
      try {
        d = JSON.parse(m.data);
      } catch (e) {
        return;
      }
      const set = listeners.get(d.event);
      if (!set) return;
      for (const cb of [...set]) {
        try {
          cb.apply(null, d.args || []);
        } catch (e) {
          /* a bad listener must not kill the stream */
        }
      }
    };
  }
  function subscribe(channel, cb) {
    ensureStream();
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(cb);
    return () => set.delete(cb); // unsubscribe, like the preload removers
  }

  expose("clutchApi", {
    baseUrl: () => call("clutchApi", "baseUrl"),
    onBaseChanged: (cb) => subscribe("backend:base-changed", cb),
  });

  expose("clutchSettings", {
    save: (data) => call("clutchSettings", "save", [data]),
    // rebuild the ~/.clutch/settings.json mirror when it is missing (self-heal)
    ensure: (data) => call("clutchSettings", "ensure", [data]),
  });

  expose("clutchTunnel", {
    connect: (cfg) => call("clutchTunnel", "connect", [cfg]),
    status: () => call("clutchTunnel", "status"),
    disconnect: () => call("clutchTunnel", "disconnect"),
    onEnd: (cb) => subscribe("tunnel:ended", cb),
    onProgress: (cb) => subscribe("tunnel:progress", cb),
  });
})();
