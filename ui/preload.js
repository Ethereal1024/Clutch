// Preload: expose native dialogs to the renderer via contextBridge.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clutchDialog", {
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),
  pickProjectFile: () => ipcRenderer.invoke("dialog:pickProjectFile"),
});
