// GENERATED FILE — do not edit; edit android/host/src/index.ts and run `node android/build-host.js`.
// source sha256: 4cd0c26df53a44cf9c7e9f0f8be7fdfea7f549606dcf1e45adede821b2b434c8

"use strict";
// nodejs-mobile entry: the Kotlin shell starts `node index.js` inside the
// copied nodejs-project; everything else happens in android-host.js.
Object.defineProperty(exports, "__esModule", { value: true });
// Boot-crash net, installed before ANY require: in embedded libnode an
// uncaught exception thrown while a module (even a builtin) is being loaded
// goes straight to node's native exit handler — no stack is printed anywhere,
// process.exit() tears down the whole app (WebView EGL teardown then aborts
// on a destroyed mutex — the "tap the apk and it dies" bug). Catch it here,
// leave the full stack in $HOME/boot-trace.log, and STAY ALIVE so the
// WebView can show the engine-error page instead of the app vanishing.
const __net = (kind) => (e) => {
    try {
        require("fs").appendFileSync(require("path").join(process.env.HOME || ".", "boot-trace.log"), `[${kind}] ` + ((e && e.stack) || e) + "\n");
    }
    catch (_) { }
};
process.on("uncaughtException", __net("fatal"));
process.on("unhandledRejection", __net("rejection"));
require("./android-host.js").main();
