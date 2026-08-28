// Preload: expose the backend URL + the SSH tunnel bridge to the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clutchApi", {
  baseUrl: process.env.CLUTCH_API_URL || "http://127.0.0.1:8890",
});

contextBridge.exposeInMainWorld("clutchTunnel", {
  connect: (cfg) => ipcRenderer.invoke("tunnel:connect", cfg),
  disconnect: () => ipcRenderer.invoke("tunnel:disconnect"),
});
