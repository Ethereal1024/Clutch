// nodejs-mobile entry: the Kotlin shell starts `node index.js` inside the
// copied nodejs-project; everything else happens in android-host.js.

// Boot-crash net, installed before ANY require: in embedded libnode an
// uncaught exception thrown while a module (even a builtin) is being loaded
// goes straight to node's native exit handler — no stack is printed anywhere,
// process.exit() tears down the whole app (WebView EGL teardown then aborts
// on a destroyed mutex — the "tap the apk and it dies" bug). Catch it here,
// leave the full stack in $HOME/boot-trace.log, and STAY ALIVE so the
// WebView can show the engine-error page instead of the app vanishing.
const __net = (kind) => (e) => {
  try {
    require("fs").appendFileSync(
      require("path").join(process.env.HOME || ".", "boot-trace.log"),
      `[${kind}] ` + ((e && e.stack) || e) + "\n",
    );
  } catch (_) {}
};
process.on("uncaughtException", __net("fatal"));
process.on("unhandledRejection", __net("rejection"));

require("./android-host.js").main();
