// The runtime half of a frontend plugin: one forked process per call.
//
// ui/plugin-host.js owns the bytes; this file owns the moment they execute. The
// split is the whole point of forking instead of require()ing in-process:
//
//   * the window cannot be frozen by a plugin that spins — the event loop that
//     renders the UI is not the one a plugin runs on;
//   * a plugin that must be stopped has a pid, so `SIGKILL` is exact;
//   * a plugin that throws at load time kills a process, not the app;
//   * and the cost is one honest sentence: this is NOT a privilege fence. The
//     child has the app's uid, its environment and its filesystem, so a plugin
//     is trusted code, installed by the user's own hand. What the fork buys is
//     containment in TIME (killable, non-blocking), not in authority.
//
// The ABI, stated once, here (the entry module is CommonJS; it is `require`d
// with cwd = the plugin's own directory, so a plugin's own relative reads work):
//
//   exports.run = async (argv) => string | {content, error?}
//
// `argv` is the tool call already rendered into WORDS: `argv[0]` is the tool's
// own name (the first word of the `command` the component declared for it) and
// `argv[1]` is the model's arguments as ONE JSON string, so a plugin takes its
// arguments the way the model spelled them and no host has to know how a tool
// is started — the declaration's `command` template is the whole of that. A
// plugin whose tools all take a single JSON object is therefore one line:
//
//   exports.run = (argv) => call(argv[0], JSON.parse(argv[1] || "{}"));
//
// `content` is the model-facing text of the result and `error` says whether the
// tool failed — the same shape `Envelope` has on the session side
// (agent/tools/envelope.py), so one result renderer reads both domains. The
// LIST of tools a plugin publishes is NOT exported here: it is the installed
// `component.json`'s `tools`, because the frontend must be able to show and
// validate a plugin's tools without running it.
//
// Protocol (IPC only; stdin/stdout are /dev/null so a plugin's own logging
// cannot corrupt the channel):
//
//   child -> parent  {type:"ready"}                    loaded, waiting
//   child -> parent  {type:"error", error}             load failed, exiting 1
//   parent -> child  {type:"call", argv}               exactly one per child
//   child -> parent  {type:"result", envelope}         done, exiting 0
//   child -> parent  {type:"error", error}             threw / bad shape, exit 1
//
// One call per process, deliberately: a plugin cannot keep a socket, a timer or
// a mutated module between two calls, so "what the plugin did" is always one
// process's lifetime and a Stop is always the whole of it.

"use strict";

// A parent that forks this file always brings a channel. Started by hand, it can
// only be a mistake by somebody reading the source: say so instead of hanging.
if (typeof process.send !== "function") {
  console.error("plugin-child.js is the runtime of ui/plugin-host.js — start it with fork(), not by hand");
  process.exit(2);
}

// The one thing a plugin's author will look at when it fails: the stack is more
// useful than the message, and a thrown non-Error (a string, a number) must not
// turn into "[object Object]".
function describe(e) {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  if (e.stack) return String(e.stack);
  if (e.message) return String(e.message);
  try {
    return JSON.stringify(e);
  } catch (ignored) {
    return String(e);
  }
}

// Answer, then leave — and leave only AFTER the message is out of this process:
// exiting first would race the channel and turn every result into "exited
// before answering". `process.exit` in the send callback is the only ordering
// node gives us, so it is what is used. The fallback timer is a guard against a
// closed channel whose callback never fires at all.
function reply(message, code) {
  const leave = () => process.exit(code);
  try {
    process.send(message, () => leave());
  } catch (e) {
    leave();
    return;
  }
  setTimeout(leave, 1000).unref();
}

const directory = process.env.CLUTCH_PLUGIN_DIR || "";
const entry = process.env.CLUTCH_PLUGIN_ENTRY || "";
const name = process.env.CLUTCH_PLUGIN_NAME || "plugin";

if (!directory || !entry) {
  reply(
    { type: "error", error: "the runtime was started without CLUTCH_PLUGIN_DIR / CLUTCH_PLUGIN_ENTRY (started by ui/plugin-host.js?)" },
    1
  );
}

// The listener goes on BEFORE "ready": the parent answers a ready with a call,
// and a message that arrives with no listener attached is dropped by node, not
// queued. That ordering is the whole reason this line sits above the require.
let loaded = null;
process.on("message", (message) => {
  if (!message || message.type !== "call" || !loaded) return;
  Promise.resolve()
    .then(() => loaded.run(argvOf(message.argv)))
    .then((out) => reply({ type: "result", envelope: normalize(out) }, 0))
    .catch((e) => reply({ type: "error", error: describe(e) }, 1));
});

// The rendered statement, checked for the one thing the ABI promises: it is
// words, and it starts with the tool's own name (which is what makes `run` able
// to tell one of its tools from another). The host rendered it, so a malformed
// one here is a host bug — say so in the plugin's name rather than throwing a
// TypeError out of a `map` on `undefined`.
function argvOf(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(`${name}: a call must carry argv (the rendered words of its statement)`);
  }
  return argv.map((word) => String(word));
}

// The return value, narrowed to what a result renderer can draw. A string is
// the common case (a tool's text); `{content, error}` is the full one. Anything
// else is refused rather than stringified: a plugin returning `undefined` is a
// bug, and "{}" written into the conversation as if it were an answer would
// hide it.
function normalize(out) {
  if (typeof out === "string") return { content: out, error: false };
  if (out && typeof out === "object" && typeof out.content === "string") {
    return { content: out.content, error: !!out.error };
  }
  const seen = out === null ? "null" : Array.isArray(out) ? "an array" : typeof out;
  throw new Error(`${name}: run(argv) returned ${seen}, expected a string or {content, error?}`);
}

try {
  const mod = require(entry);
  if (!mod || typeof mod.run !== "function") {
    throw new Error(`${name}: its entry (${entry}) exports no run(argv)`);
  }
  loaded = mod;
} catch (e) {
  reply({ type: "error", error: `could not load the plugin's entry: ${describe(e)}` }, 1);
}

try {
  process.send({ type: "ready" });
} catch (e) {
  process.exit(1);
}
