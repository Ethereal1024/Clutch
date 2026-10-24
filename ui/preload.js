// Expose the backend URL + SSH tunnel bridge to the renderer.
// baseUrl is an async IPC call: the session port is only known to the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clutchApi", {
  baseUrl: () => ipcRenderer.invoke("api:base"),
  // this window leaving its session, named by the window itself: a renderer can
  // only ever release what it holds (the main process reads e.sender), so the
  // dialog's Cancel cannot take another window's session down with it
  releaseSession: () => ipcRenderer.invoke("session:release"),
  onBaseChanged: (cb) => {
    const wrap = (_e, url) => cb(url);
    ipcRenderer.on("backend:base-changed", wrap);
    return () => ipcRenderer.removeListener("backend:base-changed", wrap);
  },
});

contextBridge.exposeInMainWorld("clutchSettings", {
  save: (data) => ipcRenderer.invoke("settings:save", data),
  // rebuild the ~/.clutch/settings.json mirror when it is missing (self-heal)
  ensure: (data) => ipcRenderer.invoke("settings:ensure", data),
});

// the plugin tab's channel: what each of the two places holds, what can be given
// either one, the writes (an install onto one, a removal off it, and the switch
// that stops driving a component there or starts it again), and the mirrors a
// failed fetch is retried through. Everything crosses ui/main.js, which picks the
// place from the component's own declaration (ui/components-view.js) — the
// renderer never writes anything itself and never chooses a machine.
contextBridge.exposeInMainWorld("clutchComponents", {
  list: () => ipcRenderer.invoke("components:list"),
  market: (opts) => ipcRenderer.invoke("components:market", opts),
  install: (name) => ipcRenderer.invoke("components:install", name),
  versions: (name) => ipcRenderer.invoke("components:versions", name),
  remove: (name, opts) => ipcRenderer.invoke("components:remove", name, opts),
  setDisabled: (name, disabled) => ipcRenderer.invoke("components:set-disabled", name, disabled),
  mirrors: () => ipcRenderer.invoke("components:mirrors"),
  addMirror: (url) => ipcRenderer.invoke("components:mirror-add", url),
  removeMirror: (url) => ipcRenderer.invoke("components:mirror-remove", url),
  onProgress: (cb) => {
    const wrap = (_e, stage) => cb(stage);
    ipcRenderer.on("components:progress", wrap);
    return () => ipcRenderer.removeListener("components:progress", wrap);
  },
});

// the About pane's update button. `check` takes the version the page is showing
// (ui/version.js) rather than letting the shell decide: the answer has to be about
// the number on screen. `download` streams its progress on its own channel
// (`update:progress`), because a download takes minutes and a spinner that is
// really a dead button gets pressed again.
contextBridge.exposeInMainWorld("clutchUpdate", {
  check: (current) => ipcRenderer.invoke("update:check", current),
  download: () => ipcRenderer.invoke("update:download"),
  install: (file) => ipcRenderer.invoke("update:install", file),
  onProgress: (cb) => {
    const wrap = (_e, stage) => cb(stage);
    ipcRenderer.on("update:progress", wrap);
    return () => ipcRenderer.removeListener("update:progress", wrap);
  },
});

contextBridge.exposeInMainWorld("clutchTunnel", {
  connect: (cfg) => ipcRenderer.invoke("tunnel:connect", cfg),
  status: () => ipcRenderer.invoke("tunnel:status"),
  disconnect: () => ipcRenderer.invoke("tunnel:disconnect"),
  onEnd: (cb) => {
    ipcRenderer.on("tunnel:ended", cb);
    return () => ipcRenderer.removeListener("tunnel:ended", cb);
  },
  onProgress: (cb) => {
    const wrap = (_e, stage) => cb(stage);
    ipcRenderer.on("tunnel:progress", wrap);
    return () => ipcRenderer.removeListener("tunnel:progress", wrap);
  },
});
