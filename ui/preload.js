// GENERATED FILE — do not edit; edit src/host/preload.ts and run `npm run build:host`.
// source sha256: 2810af1878028b83261311f666b91cc442e80ca27d0ead3ab82c0c4a6431420e

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Expose the backend URL + SSH tunnel bridge to the renderer.
// baseUrl is an async IPC call: the session port is only known to the main process.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("clutchApi", {
    // one tab's session, named by that tab's stable slotId (an absent slotId is
    // the window's default slot, which is every pre-tab call site)
    baseUrl: (slotId) => ipcRenderer.invoke("api:base", slotId),
    // claimed? which machine? is its run loop busy? — what a page reload asks
    // before re-attaching to a slot instead of spawning a second session
    slotStatus: (slotId) => ipcRenderer.invoke("slot:status", slotId),
    // this window/slot leaving its session, named by the renderer itself: a
    // renderer can only ever release what this window holds (the main process
    // reads e.sender), so the dialog's Cancel cannot take another window's
    // session down with it. No slotId = every slot this window holds.
    releaseSession: (slotId) => ipcRenderer.invoke("session:release", slotId),
    onBaseChanged: (cb) => {
        const wrap = (_e, change) => cb(change); // { slotId, url }
        ipcRenderer.on("backend:base-changed", wrap);
        return () => ipcRenderer.removeListener("backend:base-changed", wrap);
    },
    // per-slot backend target: pin this tab to a specific tunnel or to local.
    //   { kind: "local" }                          — always local supervisor
    //   { kind: "tunnel", tunnelId: string }        — route through this tunnel
    //   null                                        — clear (use the global default)
    // A change affects the NEXT claim, not the current session.
    setSlotTarget: (slotId, target) => ipcRenderer.invoke("slot:set-target", slotId, target),
    getSlotTarget: (slotId) => ipcRenderer.invoke("slot:get-target", slotId),
});
contextBridge.exposeInMainWorld("clutchSettings", {
    save: (data) => ipcRenderer.invoke("settings:save", data),
    // rebuild the ~/.clutch/settings.json mirror when it is missing (self-heal)
    ensure: (data) => ipcRenderer.invoke("settings:ensure", data),
});
// the plugin list's channel: what each of the two places holds, what can be given
// either one, the writes (an install onto one, a removal off it, and the switch
// that stops driving a component there or starts it again), and the mirrors a
// failed fetch is retried through. Everything crosses ui/main.js, which picks the
// place from the component's own declaration (ui/components-view.js) — the
// renderer never writes anything itself and never chooses a machine.
//
// The verbs that touch a MACHINE take the slotId of the tab whose page is asking
// (the same spelling `clutchRun` uses): one tab is one session, two tabs can sit
// on two machines, and what a machine holds is only true of the tab that asked.
// The mirror verbs do not — a mirror is this window's network, not a machine's.
contextBridge.exposeInMainWorld("clutchComponents", {
    list: (slotId) => ipcRenderer.invoke("components:list", slotId),
    market: (opts) => ipcRenderer.invoke("components:market", opts),
    install: (name, slotId) => ipcRenderer.invoke("components:install", name, slotId),
    versions: (name, slotId) => ipcRenderer.invoke("components:versions", name, slotId),
    remove: (name, opts, slotId) => ipcRenderer.invoke("components:remove", name, opts, slotId),
    setDisabled: (name, disabled, slotId) => ipcRenderer.invoke("components:set-disabled", name, disabled, slotId),
    settings: (name, slotId) => ipcRenderer.invoke("components:settings", name, slotId),
    setSetting: (name, values, slotId) => ipcRenderer.invoke("components:set-setting", name, values, slotId),
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
    // list active/recently-active tunnels for the backend picker
    list: () => ipcRenderer.invoke("tunnel:list"),
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
// custom titlebar: minimize / maximize / close — fire-and-forget (no return value).
// Exposed ONCE: a second exposeInMainWorld("clutchWin") throws "Cannot bind an
// API on top of an existing property", which aborts this preload and leaves
// every later bridge (clutchRun!) undefined.
contextBridge.exposeInMainWorld("clutchWin", {
    minimize: () => ipcRenderer.send("win:minimize"),
    maximize: () => ipcRenderer.send("win:maximize"),
    close: () => ipcRenderer.send("win:close"),
});
// the host-side run loop (P1-4): the renderer is a view only — it calls
// start/stop/step/drive/state and subscribes to run:event pushes. The loop
// survives a page reload: the main process owns it, so a closed window does
// not cancel an in-flight turn (the aborted final is written on close).
// start takes the page's payload {task, mode, project} — one object, because
// the three travel together: the mode picks the tool surface the loop is built
// with, and the project is the .clc the page believes it is showing (a claim
// the host checks, ui/run-session.js, never a path an append could follow).
// state takes that same {mode, project} pair (no task: it asks instead of
// writes) — it is how a page that was not there when the turn opened learns
// whether a turn is still open, and it builds the loop when there is none yet.
// The two-argument verbs also accept the pre-tabs spelling, start(payload):
// a first argument that is not a slot string IS the payload.
function runArgs(slotOrPayload, maybePayload) {
    return typeof slotOrPayload === "string"
        ? [slotOrPayload, maybePayload]
        : ["", slotOrPayload];
}
contextBridge.exposeInMainWorld("clutchRun", {
    // every verb names the slot (one tab) it belongs to: two tabs run two turns
    // in parallel, and a background tab's event must never drive the active one.
    start: (slotId, payload) => ipcRenderer.invoke("run:start", ...runArgs(slotId, payload)),
    run: (slotId, payload) => ipcRenderer.invoke("run:run", ...runArgs(slotId, payload)),
    stop: (slotId) => ipcRenderer.invoke("run:stop", slotId),
    step: (slotId) => ipcRenderer.invoke("run:step", slotId),
    drive: (slotId) => ipcRenderer.invoke("run:drive", slotId),
    state: (slotId, payload) => ipcRenderer.invoke("run:state", ...runArgs(slotId, payload)),
    onEvent: (cb) => {
        const wrap = (_e, ev) => cb(ev); // { slotId, event }
        ipcRenderer.on("run:event", wrap);
        return () => ipcRenderer.removeListener("run:event", wrap);
    },
});
