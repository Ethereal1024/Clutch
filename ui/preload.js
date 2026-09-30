// Expose the backend URL + SSH tunnel bridge to the renderer.
// baseUrl is an async IPC call: the session port is only known to the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clutchApi", {
  baseUrl: () => ipcRenderer.invoke("api:base"),
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

// the plugin tab's channel: what the target machine holds, what this client
// could give it, and the two writes (one install onto that machine, one removal
// off it). Everything crosses ui/main.js, which talks to the target machine's
// supervisor (ui/components-view.js) — the renderer never writes anything itself.
contextBridge.exposeInMainWorld("clutchComponents", {
  list: () => ipcRenderer.invoke("components:list"),
  market: (opts) => ipcRenderer.invoke("components:market", opts),
  install: (name) => ipcRenderer.invoke("components:install", name),
  versions: (name) => ipcRenderer.invoke("components:versions", name),
  remove: (name, opts) => ipcRenderer.invoke("components:remove", name, opts),
  onProgress: (cb) => {
    const wrap = (_e, stage) => cb(stage);
    ipcRenderer.on("components:progress", wrap);
    return () => ipcRenderer.removeListener("components:progress", wrap);
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
