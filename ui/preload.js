// Preload: expose native dialogs + the backend API URL to the renderer.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clutchDialog", {
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
  pickProjectFile: () => ipcRenderer.invoke("dialog:pickProjectFile"),
});

// Backend base URL (from CLUTCH_API_URL in the main process); the renderer uses
// it as the default when no in-app override is set.
contextBridge.exposeInMainWorld("clutchApi", {
  baseUrl: process.env.CLUTCH_API_URL || "http://127.0.0.1:8890",
});
