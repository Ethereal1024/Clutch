// ui/plugin-host.js is this client's own component domain: the root the WINDOW's
// machine owns, the table beside it, the digest gate in front of it, and the
// forked runtime behind it. This runner drives the REAL host against a throwaway
// root (createPluginHost({root})), so every claim it makes is about this file and
// not about a fake: no Electron, no supervisor, no session machine.
//
// What it pins, in the order the host itself uses them: a read never creates the
// root; an install is atomic and prunes the version it replaces; the digest is
// measured HERE and a mismatch lays nothing down; a bad name / version /
// interface is refused by the same spelling the session domain uses; a removal of
// something not held is a refusal while a removal of nothing is "absent"; the
// table — not the disk — is what `list` means, and reindex() is the only way a
// hand-placed payload becomes a component; and the runtime answers, throws,
// times out, and comes back to life, one forked process per call.
// Run: node tests/plugin-host.test.js
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { check, summary } = require("./harness");
const pluginHost = require("../ui/plugin-host");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-plugin-"));
const DIGEST_BOGUS = "0".repeat(64);

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function digestOf(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// "did this throw, and did the sentence say why": a bare `throws` would pass on
// an unrelated TypeError, which is exactly how a security refusal can rot into a
// crash nobody notices.
function refuses(fn, pattern) {
  try {
    fn();
    return false;
  } catch (e) {
    if (!pattern) return true;
    const message = String((e && e.message) || e);
    if (!pattern.test(message)) {
      console.log(`      (threw ${JSON.stringify(message)}, expected ${pattern})`);
      return false;
    }
    return true;
  }
}

async function rejects(promise, pattern) {
  try {
    await promise;
    return false;
  } catch (e) {
    const message = String((e && e.message) || e);
    if (!pattern) return true;
    if (!pattern.test(message)) {
      console.log(`      (rejected ${JSON.stringify(message)}, expected ${pattern})`);
      return false;
    }
    return true;
  }
}

// A plugin payload on disk, outside the domain root (a checkout, a download
// unpacked by ui/components.js, a dev tree).
// The statement a declaration carries for a tool, at its simplest: the tool's own
// name first (the ABI is `run(argv)`, and argv[0] is the tool) and the model's
// arguments as one JSON word after it.
const S = (tool) => `${tool} {*}`;

// The ABI the runtime speaks (ui/plugin-child.js): argv is words, argv[1] is the
// arguments as one JSON string. Spelled once here so a fixture stays about the
// host rather than about this boilerplate.
const ARGS = "JSON.parse(argv[1] || '{}')";

function pluginSource(label, opts = {}) {
  const dir = path.join(ROOT, "src", label);
  // a fixture declares tools, not statements: the statement a tool has is
  // `<name> {*}`, which is what the shipped plugins declare and what the ABI
  // requires (argv[0] is the tool's own name)
  const tools = (opts.tools || [{ name: "echo", description: "say it back" }]).map((tool) =>
    tool && typeof tool === "object" && !tool.command ? { ...tool, command: S(tool.name) } : tool
  );
  const declaration = {
    name: opts.name || label,
    version: "0.1.0",
    interface: opts.interface || "plugin",
    entry: opts.entry || "index.js",
    tools,
  };
  if (opts.extra) Object.assign(declaration, opts.extra);
  write(path.join(dir, "component.json"), JSON.stringify(declaration, null, 2) + "\n");
  if (opts.entry === undefined || opts.entry) {
    write(path.join(dir, opts.entry || "index.js"), opts.code || "exports.run = async () => ({content: 'ok'});\n");
  }
  if (opts.files) for (const [name, text] of Object.entries(opts.files)) write(path.join(dir, name), text);
  return dir;
}

function tarball(source, name) {
  const file = path.join(ROOT, "artifacts", `${name}.tar.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tar = spawnSync("tar", ["-czf", file, "-C", source, "."], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr || tar.error}`);
  return file;
}

function freshRoot(label) {
  return path.join(ROOT, "domains", label);
}

const MANIFEST = { name: "echo", version: "0.1.0", interface: "plugin", entry: "index.js" };
const ECHO = `exports.run = async (argv) => ({content: argv[0] + ':' + (${ARGS}.text || ''), error: false});\n`;

async function main() {
  // ---------------------------------------------------------- the empty domain
  {
    const host = pluginHost.createPluginHost({ root: freshRoot("empty") });
    check(host.list().length === 0, "empty: a client that installed nothing lists nothing");
    check(!fs.existsSync(host.root), "empty: a READ does not create the root (reading is not installing)");
    check(host.resolve("echo") === null, "empty: resolving an absent component answers null");
    check(await rejects(host.call({ name: "echo", command: S("echo") }), /is not installed for this client/),
      "empty: calling an absent component is a refusal that says so");
    check(pluginHost.defaultRoot().endsWith(path.join(".clutch", "client")) || !!process.env.CLUTCH_CLIENT_COMPONENTS_DIR,
      "empty: the default root is this CLIENT's, beside ~/.clutch/artifacts");
  }

  // -------------------------------------------------------- install + resolve
  const host = pluginHost.createPluginHost({ root: freshRoot("main") });
  {
    const src = pluginSource("echo", { code: ECHO });
    const record = host.install({ manifest: { ...MANIFEST }, artifact: src });
    check(record.name === "echo" && record.version === "0.1.0", "install: the verdict names what went in");
    check(record.location === "echo/0.1.0", "install: the location is recorded relative to the root (a movable root)");

    const rows = host.list();
    check(rows.length === 1 && rows[0].interface === "plugin", "install: the table has one plugin row");
    check(rows[0].disabled === false, "install: a fresh component is not stopped");

    const resolved = host.resolve("echo");
    check(!!resolved, "resolve: an installed plugin resolves");
    check(resolved.entry === path.join(host.root, "echo", "0.1.0", "index.js"), "resolve: the entry is inside the payload");
    const declaration = readJSON(path.join(resolved.directory, "component.json"));
    check(declaration.tools && declaration.tools.length === 1 && declaration.tools[0].name === "echo",
      "install: the declaration of record stays with the bytes, tools included");
  }

  // -------------------------------------- replace: prune the old, keep `disabled`
  {
    host.setDisabled("echo", true);
    check(host.list()[0].disabled === true, "disabled: the switch is one bit on the row");
    const src = pluginSource("echo", { code: ECHO, extra: { version: "0.2.0" } });
    host.install({ manifest: { ...MANIFEST }, artifact: src, version: "0.2.0" });
    const rows = host.list();
    check(rows.length === 1 && rows[0].version === "0.2.0", "replace: a client holds one version of a component");
    check(!fs.existsSync(path.join(host.root, "echo", "0.1.0")), "replace: the other version's payload is pruned");
    check(rows[0].disabled === true, "replace: `stopped` is about the component, so it rides across the install");
    host.setDisabled("echo", false);
    check(host.list()[0].disabled === false, "disabled: the switch goes back");
  }

  // -------------------------------------------------- a stale row is not a plugin
  {
    // the table can outlive its bytes (a half-copied root, a hand edit). A row
    // that sorts newest but names nothing must not shadow a version that loads.
    const table = readJSON(pluginHost.registryPath(host.root));
    table.components.unshift({
      name: "echo",
      version: "9.9.9",
      interface: "plugin",
      digest: "",
      location: "echo/9.9.9",
      disabled: false,
    });
    fs.writeFileSync(pluginHost.registryPath(host.root), JSON.stringify(table), "utf8");
    const resolved = host.resolve("echo");
    check(!!resolved && resolved.record.version === "0.2.0",
      "resolve: a row whose payload is gone does not shadow the version that loads");
    host.reindex();
    check(host.list().length === 1 && host.list()[0].version === "0.2.0",
      "reindex: the rebuild drops a row whose bytes are gone");
  }

  // -------------------------------------------------- install from an archive
  {
    const host2 = pluginHost.createPluginHost({ root: freshRoot("archive") });
    const src = pluginSource("arch", { code: ECHO, extra: { version: "0.3.0" } });
    const file = tarball(src, "arch");
    const digest = digestOf(file);
    const record = host2.install({
      manifest: { name: "arch", version: "0.3.0", interface: "plugin", entry: "index.js", digest },
      artifact: file,
    });
    check(record.digest === digest, "archive: the measured digest is what the row records");
    check(!!host2.resolve("arch"), "archive: an unpacked plugin resolves");
    check(!fs.existsSync(path.join(host2.root, "arch", "0.3.0", ".installing")), "archive: no staging survives a success");

    // the gate: a pinned digest that is not these bytes refuses BEFORE anything
    // is laid down, so the table still says exactly what is on disk
    const before = host2.list().length;
    const wrong = {
      name: "bad",
      version: "0.1.0",
      interface: "plugin",
      entry: "index.js",
      digest: DIGEST_BOGUS,
    };
    check(refuses(() => host2.install({ manifest: wrong, artifact: file }), /is not the pinned/),
      "gate: a digest mismatch is refused");
    check(host2.list().length === before, "gate: a refused install leaves the table untouched");
    check(!fs.existsSync(path.join(host2.root, "bad")), "gate: a refused install leaves no staging behind");

    // and the same gate on a single-file artifact (a prebuilt runtime, a script)
    const script = write(path.join(ROOT, "src", "single", "run.sh"), "#!/bin/sh\necho hi\n");
    check(refuses(() => host2.install({
      manifest: { name: "single", version: "0.1.0", interface: "plugin", entry: "single", digest: DIGEST_BOGUS },
      artifact: script,
    }), /is not the pinned/), "gate: a single file is hashed the same way");
    const single = host2.install({
      manifest: { name: "single", version: "0.1.0", interface: "plugin", entry: "single", digest: digestOf(script) },
      artifact: script,
    });
    check(single.name === "single" && fs.existsSync(path.join(host2.root, "single", "0.1.0", "single")),
      "install: a single-file artifact lands as <name> and the manifest says how to start it");
  }

  // -------------------------------------------------------------- the refusals
  {
    const host3 = pluginHost.createPluginHost({ root: freshRoot("refusals") });
    const src = pluginSource("ok");
    check(refuses(() => host3.install({ manifest: { ...MANIFEST, name: "../escape" }, artifact: src }), /bad component name/),
      "refuse: a name that is a path is not a component name");
    check(refuses(() => host3.install({ manifest: { ...MANIFEST }, artifact: src, version: "../1" }), /bad component version/),
      "refuse: a version that is a path is not a version");
    check(refuses(() => host3.install({ manifest: { ...MANIFEST, interface: "cli" }, artifact: src }),
      /belongs to the machine that runs the session/),
      "refuse: a cli/daemon manifest is another domain's component, not this client's");
    check(refuses(() => host3.install({ manifest: { ...MANIFEST } }), /needs an artifact/), "refuse: install without bytes");
    check(!fs.existsSync(host3.root), "refuse: nothing refused has created the root");
  }

  // -------------------------------------------------------- remove / stop / reindex
  {
    const host4 = pluginHost.createPluginHost({ root: freshRoot("lifecycle") });
    const src = pluginSource("gone", { code: ECHO });
    host4.install({ manifest: { ...MANIFEST, name: "gone" }, artifact: src });
    check(host4.setDisabled("never", true).status === "absent", "stop: stopping a component this client does not hold is `absent`");
    check(host4.remove("never").status === "absent", "remove: removing nothing is `absent`, not an error");
    check(refuses(() => host4.remove("gone", "9.9.9"), /is not held by this client/),
      "remove: asking for a version that is not held is a refusal (a typo is not a fact)");
    const verdict = host4.remove("gone");
    check(verdict.status === "removed" && verdict.removed[0] === "0.1.0", "remove: the verdict names what went");
    check(!fs.existsSync(path.join(host4.root, "gone")), "remove: an emptied component directory is not left behind");
    check(host4.list().length === 0, "remove: the table no longer lists it");
    check(host4.remove("gone").status === "absent", "remove: removing it twice is `absent` the second time");

    // the table is bookkeeping; the disk alone is not a component
    fs.mkdirSync(path.join(host4.root, "hand", "0.1.0"), { recursive: true });
    write(path.join(host4.root, "hand", "0.1.0", "component.json"),
      JSON.stringify({ name: "hand", version: "0.1.0", interface: "plugin", entry: "index.js", tools: [{ name: "t" }] }));
    write(path.join(host4.root, "hand", "0.1.0", "index.js"), "exports.run = async () => 'hand';\n");
    check(host4.list().length === 0, "reindex: a payload copied in by hand is not a component until it is adopted");
    const adopted = host4.reindex();
    check(adopted.length === 1 && adopted[0].name === "hand", "reindex: the deliberate rebuild adopts it");
    check(host4.list().length === 1 && host4.resolve("hand") !== null, "reindex: and it resolves afterwards");

    // a hand-placed payload that declares a DIFFERENT name is not adopted: the
    // declaration of record is the artifact's own, and it disagrees with the path
    write(path.join(host4.root, "liar", "0.1.0", "component.json"),
      JSON.stringify({ name: "not-liar", version: "0.1.0", interface: "plugin", entry: "index.js" }));
    check(host4.reindex().length === 1, "reindex: a payload that calls itself something else is not adopted");

    // a malformed table is an error, never a silent "nothing is installed"
    write(pluginHost.registryPath(host4.root), "{not json");
    check(refuses(() => host4.list(), /reindex\(\) rebuilds it from the disk/), "table: a malformed registry is refused by name");
    host4.reindex();
    check(host4.list().length === 1, "table: reindex is the way back from a malformed table");
  }

  // ---------------------------------------------------------------- the runtime
  {
    const runtime = pluginHost.createPluginHost({ root: freshRoot("runtime") });
    const ok = pluginSource("echo", { code: ECHO });
    runtime.install({ manifest: { ...MANIFEST }, artifact: ok });

    const answer = await runtime.call({ name: "echo", command: S("echo"), args: { text: "hi" } });
    check(answer.content === "echo:hi" && answer.error === false, "call: the plugin's whole envelope comes back");

    const plain = pluginSource("plain", {
      code: "exports.run = async () => 'just text';\n",
      tools: [{ name: "echo" }],
    });
    runtime.install({ manifest: { ...MANIFEST, name: "plain" }, artifact: plain });
    const text = await runtime.call({ name: "plain", command: S("echo") });
    check(text.content === "just text" && text.error === false, "call: a bare string is the common case and needs no envelope");

    // cwd + the env the runtime promises: a plugin's own files are beside it
    const local = pluginSource("local", {
      code: "const fs = require('fs');\nexports.run = async () => fs.readFileSync('data.txt', 'utf8').trim() + '@' + fs.readFileSync(process.env.CLUTCH_PLUGIN_DIR + '/data.txt', 'utf8').trim();\n",
      files: { "data.txt": "beside\n" },
      tools: [{ name: "read" }],
    });
    runtime.install({ manifest: { ...MANIFEST, name: "local" }, artifact: local });
    const where = await runtime.call({ name: "local", command: S("read") });
    check(where.content === "beside@beside", "call: cwd is the plugin's own directory and the env names it too");

    // the exec bridge (C9.1): the far side of a tunnel, handed to the child as an
    // address. It is asked for at every call, because the port only exists while a
    // tunnel is up; "no tunnel" must be the empty string, not a stale port.
    const BRIDGE = "http://127.0.0.1:47111";
    let bridge = "";
    const bridged = pluginHost.createPluginHost({
      root: freshRoot("bridge"),
      execBridge: () => bridge,
    });
    const asker = pluginSource("asker", {
      code: "exports.run = async () => 'bridge=' + JSON.stringify(process.env.CLUTCH_EXEC_BRIDGE);\n",
      tools: [{ name: "echo" }],
    });
    bridged.install({ manifest: { ...MANIFEST, name: "asker" }, artifact: asker });
    check((await bridged.call({ name: "asker", command: S("echo") })).content === 'bridge=""',
      "exec bridge: with no tunnel the child is told there is no bridge (empty, not a guess)");
    bridge = BRIDGE;
    check((await bridged.call({ name: "asker", command: S("echo") })).content === `bridge=${JSON.stringify(BRIDGE)}`,
      "exec bridge: a tunnel that came up after the host was created still reaches the child");
    const bare = pluginHost.createPluginHost({ root: freshRoot("bridge-unwired") });
    bare.install({ manifest: { ...MANIFEST, name: "asker" }, artifact: asker });
    check((await bare.call({ name: "asker", command: S("echo") })).content === 'bridge=""',
      "exec bridge: a host with no bridge source passes an empty value rather than refusing to run plugins");

    // no bridge is a fact a plugin answers WITH, not a call that hangs
    const stranded = pluginSource("stranded", {
      code: "exports.run = async () => { if (!process.env.CLUTCH_EXEC_BRIDGE) throw new Error('no exec bridge right now'); return 'ok'; };\n",
      tools: [{ name: "echo" }],
    });
    bare.install({ manifest: { ...MANIFEST, name: "stranded" }, artifact: stranded });
    check(await rejects(bare.call({ name: "stranded", command: S("echo") }), /no exec bridge right now/),
      "exec bridge: without one the call fails the way any plugin failure does, and does not hang");

    // the exec budget (C9.3): the bridge takes one command and no stdin, so the
    // numbers that bound it come from the host (ui/transport_defaults.json), not
    // from each plugin's memory of them.
    const budgeted = pluginHost.createPluginHost({
      root: freshRoot("budget"),
      execLimits: { maxCommandBytes: 6000, chunkBytes: 3500 },
    });
    const sized = pluginSource("sized", {
      code: "exports.run = async () => [process.env.CLUTCH_EXEC_MAX_COMMAND_BYTES, process.env.CLUTCH_EXEC_CHUNK_BYTES].join('/');\n",
      tools: [{ name: "echo" }],
    });
    budgeted.install({ manifest: { ...MANIFEST, name: "sized" }, artifact: sized });
    check((await budgeted.call({ name: "sized", command: S("echo") })).content === "6000/3500",
      "exec budget: both numbers reach the child when the host states them");
    bare.install({ manifest: { ...MANIFEST, name: "sized" }, artifact: sized });
    check((await bare.call({ name: "sized", command: S("echo") })).content === "/",
      "exec budget: a host with no opinion says nothing at all, rather than inventing a number");

    // a plugin's own logging cannot corrupt the result channel
    const noisy = pluginSource("noisy", {
      code: "console.log('noise'); console.error('more noise');\nexports.run = async () => 'clean';\n",
      tools: [{ name: "echo" }],
    });
    runtime.install({ manifest: { ...MANIFEST, name: "noisy" }, artifact: noisy });
    check((await runtime.call({ name: "noisy", command: S("echo") })).content === "clean",
      "call: stdout is nobody's, so a plugin cannot write into the answer");

    // a throw is the plugin's failure, reported as a failed call
    const angry = pluginSource("angry", {
      code: "exports.run = async () => { throw new Error('boom from the plugin'); };\n",
      tools: [{ name: "echo" }],
    });
    runtime.install({ manifest: { ...MANIFEST, name: "angry" }, artifact: angry });
    check(await rejects(runtime.call({ name: "angry", command: S("echo") }), /boom from the plugin/),
      "call: a throw is a rejection that carries the plugin's own words");

    // a plugin whose entry does not load, and one that exports no call()
    const broken = pluginSource("broken", { code: "this is not javascript(\n" });
    runtime.install({ manifest: { ...MANIFEST, name: "broken" }, artifact: broken });
    check(await rejects(runtime.call({ name: "broken", command: S("echo") }), /could not load the plugin's entry/),
      "call: an entry that will not load fails the call, not the app");
    const empty = pluginSource("empty", { code: "exports.tools = [];\n" });
    runtime.install({ manifest: { ...MANIFEST, name: "empty" }, artifact: empty });
    check(await rejects(runtime.call({ name: "empty", command: S("echo") }), /exports no run/),
      "call: an entry with no run(argv) is refused by name");

    // a return value the result renderer cannot draw is refused, not stringified
    const odd = pluginSource("odd", { code: "exports.run = async () => undefined;\n", tools: [{ name: "echo" }] });
    runtime.install({ manifest: { ...MANIFEST, name: "odd" }, artifact: odd });
    check(await rejects(runtime.call({ name: "odd", command: S("echo") }), /expected a string or \{content/),
      "call: returning nothing is a bug in the plugin, not an empty answer");

    // a statement the declaration does not carry never reaches a process: the
    // client runs what IT declared, so an invented flag is refused here, byte
    // for byte, without forking
    check(await rejects(runtime.call({ name: "echo", command: "echo --force {*}" }), /declares no tool with the statement/),
      "call: a statement the component did not declare is refused from the declaration");
    check(await rejects(runtime.call({ name: "echo", command: S("search") }), /declares no tool with the statement/),
      "call: a tool that was never published cannot be named either");
    check(await rejects(runtime.call({ name: "echo" }), /needs the statement to run/), "call: no statement, no call");

    // stopped means stopped
    runtime.setDisabled("echo", true);
    check(await rejects(runtime.call({ name: "echo", command: S("echo") }), /is stopped on this client/),
      "call: a stopped component is refused before it is started");
    runtime.setDisabled("echo", false);
    check((await runtime.call({ name: "echo", command: S("echo"), args: { text: "again" } })).content === "echo:again",
      "call: starting it again works");

    // the timeout kills the process and the host keeps working afterwards
    const slow = pluginSource("slow", {
      code: "exports.run = async () => new Promise(() => {});\n",
      tools: [{ name: "echo" }],
    });
    runtime.install({ manifest: { ...MANIFEST, name: "slow" }, artifact: slow });
    check(await rejects(runtime.call({ name: "slow", command: S("echo"), timeoutMs: 300 }), /did not answer within 300ms/),
      "call: a plugin that never answers is stopped, and the caller is told");
    check((await runtime.call({ name: "echo", command: S("echo"), args: { text: "alive" } })).content === "echo:alive",
      "call: one hung plugin does not take the runtime with it");
  }

  // ------------------------------------------------- the statement -> argv
  {
    // renderArgv is the one place a declaration becomes words, and it is exported
    // so it can be pinned without a plugin process (a plugin would only show that
    // the words arrived, not what they were).
    const render = pluginHost.renderArgv;

    check(JSON.stringify(render("tool {*}", { b: 2, a: 1 })) === JSON.stringify(["tool", '{"a":1,"b":2}']),
      "argv: {*} is the whole argument object as ONE JSON word, keys sorted (the session's own jarg order)");
    check(JSON.stringify(render("tool {path}", { path: "/a b/c" })) === JSON.stringify(["tool", "/a b/c"]),
      "argv: a value is one word even when it holds a space — there is no shell to re-split it");
    check(JSON.stringify(render("tool {text}", { text: "one\ntwo" })) === JSON.stringify(["tool", "one\ntwo"]),
      "argv: …and even when it holds a newline");
    check(JSON.stringify(render("tool {dir}", {}, { dir: "/opt/c" })) === JSON.stringify(["tool", "/opt/c"]),
      "argv: {dir} is the client's own fact (where the component is installed)");
    check(
      JSON.stringify(render("tool {name}", { name: "deep" }, { dir: "/opt/c" })) === JSON.stringify(["tool", "deep"]),
      "argv: every other name is the MODEL's argument, never a client fact ({name} is clutch-memory's argument)"
    );
    check(JSON.stringify(render("tool a [--limit {limit}]", { a: "x" })) === JSON.stringify(["tool", "a"]),
      "argv: an optional group with a missing placeholder is dropped whole, flag and brackets included");
    check(
      JSON.stringify(render("tool a [--limit {limit}]", { a: "x", limit: 3 })) === JSON.stringify(["tool", "a", "--limit", "3"]),
      "argv: …and kept whole when the model did ask for it"
    );
    check(JSON.stringify(render("tool [[x]]", {})) === JSON.stringify(["tool", "[x]"]),
      "argv: [[ and ]] are a literal bracket, not a group");
    check(refuses(() => render("tool {path}", {}), /missing value for \{path\}/),
      "argv: a missing placeholder outside a group is an error that names it");
    check(refuses(() => render("tool {path", {}), /bad placeholder/), "argv: a malformed placeholder is refused");
    check(refuses(() => render("tool [x", {}), /unclosed '\['/), "argv: an unclosed group is refused");
    check(refuses(() => render("tool ]", {}), /unmatched '\]'/), "argv: a stray closing bracket is refused");
    check(refuses(() => render("   ", {}), /renders to no words/), "argv: a template of whitespace is not a call");

    // and the ABI check on top of it: argv[0] is the tool, so a declaration whose
    // first word is something else is refused at call time (it would leave the
    // plugin unable to tell which of its tools it was handed)
    const wrongFirst = pluginSource("misnamed", {
      code: "exports.run = async (argv) => ({content: argv.join('|')});\n",
      tools: [{ name: "echo", command: "say {*}" }],
    });
    const runtime2 = pluginHost.createPluginHost({ root: freshRoot("misnamed") });
    runtime2.install({ manifest: { ...MANIFEST, name: "misnamed" }, artifact: wrongFirst });
    check(await rejects(runtime2.call({ name: "misnamed", command: "say {*}" }), /first word is its own name/),
      "call: a statement whose first word is not the tool's name does not meet the ABI");
  }

  summary("plugin-host");
}

main().catch((e) => {
  check(false, `suite crashed: ${(e && e.stack) || e}`);
  summary("plugin-host");
});
