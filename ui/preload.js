// Preload: expose the backend URL + the SSH tunnel bridge to the renderer.
// baseUrl is an async call into the main process: the sandboxed preload has no
// fs/child access and this window's session child (spawned by the machine
// supervisor, agent/server.py --port 0) runs on a random port that only the
// main process knows. The main process may re-establish a dead session at any
// time and announce the new URL via onBaseChanged.
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
