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
