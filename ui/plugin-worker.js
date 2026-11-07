// GENERATED FILE — do not edit; edit src/host/plugin-worker.ts and run `npm run build:host`.
// source sha256: 5ac22ce2c9bc17c8a14fa67b0335d3a916278eb954b8a668972062d10a90f43f

// The runtime for a host that cannot fork: one worker thread per plugin call.
//
// ui/plugin-host.js starts a plugin through a `spawn` port and defaults to
// child_process.fork — a real process, a real pid, `SIGKILL` for a plugin that
// will not stop. That needs a node binary to exec, and the phone has none: its
// engine is nodejs-mobile's libnode loaded INTO the app process
// (android/app/src/main/cpp/native-lib.cpp calls node::Start), so
// `process.execPath` is the app itself and a fork would exec the app with node's
// arguments and die. This file is the same containment without a binary.
//
// What a worker thread buys, exactly:
//
//   * its own isolate and heap, so a plugin that spins cannot freeze the host's
//     event loop (which, since P1-4, is the loop that runs a whole turn);
//   * `terminate()`, which stops a plugin stuck in a tight loop — the same
//     killability a fork gets from SIGKILL, without a process;
//   * a throw at load time kills the thread, not the app;
//   * and the same one-call-per-thread lifetime: no socket, timer or mutated
//     module survives between two calls (ui/plugin-child.js says why).
//
// What it does NOT buy, said here rather than discovered by a plugin author: a
// worker cannot chdir (node refuses it, because the working directory belongs to
// the process), so a plugin under this runtime finds its own files through
// `__dirname` or `CLUTCH_PLUGIN_DIR` — both always true — and a relative path
// passed to `fs` resolves against the APP's directory instead of the plugin's.
// That is the one difference from the forked runtime, and it is why a plugin that
// reads data files should use `__dirname`: then it runs identically in both.
//
// The adapter below is deliberately child-LIKE (`.on("message"|"error"|"exit")`,
// `.send()`, `.kill()`, `.stderr`) instead of a new interface, so plugin-host has
// one code path and cannot drift into "the phone works differently".
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Required at load: a node build without worker_threads is a build where this
// host has no runtime at all, and that must be a sentence at wiring time rather
// than a mysterious failure at the first tool call.
const { Worker } = require("worker_threads");
const path = require("path");
// The child entry this module starts: ui/plugin-child.js, resolved from HERE so a
// phone layout (ui/ copied beside the host) and the repo layout both work.
const CHILD = path.join(__dirname, "plugin-child.js");
// Start one call's runtime. The shape `plugin-host.call` waits for, no more:
// messages out, messages in, and a kill that really stops the thread.
//
// `env` is the plugin's whole environment (the CLUTCH_* contract plus the host's
// own), passed as the worker's `process.env` — a copy per worker, so one plugin
// cannot leak a variable into the next. stdout is a pipe nobody reads (a plugin's
// console.log must not land in the app's output); stderr is kept, because it is
// the only thing left to say why a plugin died before answering.
function spawnInWorker({ childEntry, env } = {}) {
    const worker = new Worker(childEntry || CHILD, { env, stdout: true, stderr: true });
    return {
        stderr: worker.stderr,
        send: (message) => worker.postMessage(message),
        // `terminate()` is async by contract; nobody waits for it — the answer (or the
        // failure) has already been settled when this is called.
        kill: () => {
            try {
                worker.terminate();
            }
            catch (e) {
                /* already gone */
            }
        },
        on: (event, fn) => worker.on(event, fn),
        removeAllListeners: (event) => worker.removeAllListeners(event),
    };
}
module.exports = { CHILD, spawnInWorker };
