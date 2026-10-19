// The client's OWN component domain: plugins this app holds and runs itself.
//
// There are two component domains in Clutch and only one of them existed until
// now. The other one is the SESSION machine's: agent/tools/components.py owns
// `~/.clutch/components`, the supervisor's /api/components installs into it, and
// rendezvous spawns what it holds — all of that is "the machine the agent runs
// on". A frontend plugin is not that: its bytes live on the machine the WINDOW
// runs on, its writer is the app process (the Electron main process, the Android
// host), and what runs it is this file's runtime, not rendezvous. So it gets its
// own root, its own table and its own verbs — the same verbs, deliberately, so
// the plugin page can draw both domains with one renderer.
//
// Why a separate root is not cosmetic: on a desktop the session machine can BE
// this machine (the local supervisor serves `~/.clutch/components`). Sharing one
// directory would give one registry.json two writers — the app process and that
// supervisor — which is exactly the "two truths" PLUGIN_PLAN.md 零之四.1/3 rules
// out. Two domains, two roots, one writer each:
//
//   ~/.clutch/components          the session machine (a supervisor)
//   ~/.clutch/client              this client (this app process)
//
// What a record IS, and what it is not: the table is bookkeeping (name, version,
// interface, digest, location, disabled) and the DECLARATION of record stays with
// the bytes, in the installed `component.json` — the same split as the session
// domain (components.py `_entry` vs `_merge_declaration`). A row nobody recorded
// is not a component (a directory copied in by hand is picked up only by
// reindex()), and a recorded row stays listed while its payload is replaced.
//
// The gate is the digest, measured HERE: an install names the sha256 it expects
// and this file hashes the artifact it was handed, refusing a mismatch before a
// single byte is laid down. That is the same rule the session domain applies when
// it receives a body (components.py `accept`), stated about the machine that
// holds the bytes — which, for a frontend plugin, is this one.
//
// The runtime is a forked child (see `call`): a plugin runs with this app's
// privileges either way, but not in this app's event loop, so a plugin that spins
// cannot freeze the window and a plugin that must be stopped has a pid to kill.
//
// Stdlib only (node builtins): this module is shipped to Android's embedded
// node as well, where there is no npm tree.

"use strict";

const { fork, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MANIFEST = "component.json"; // the declaration of record, inside the installed version
const REGISTRY = "registry.json"; // the table beside the payload dirs
const REGISTRY_SCHEMA = 1; // the table's own version: a future shape is refused by name
const ROOT_ENV = "CLUTCH_CLIENT_COMPONENTS_DIR"; // repoints the whole root (tests, unusual layouts)
const INSTALLING = ".installing"; // the sibling a payload is laid down in before it is renamed
const ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".tar", ".zip"];
// How long a plugin may take before its process is killed and the call fails.
// Generous, because a search plugin may legitimately spend seconds on the
// network, and cheap, because a hung call holds a pid rather than the window.
const CALL_TIMEOUT_MS = 30000;
// NOTE: this file is shipped to the phone by hand (scripts/sync-android-host.sh
// UI_NODE) and the runtime is started by PATH, not by `require`, so the asset
// walker in tests/android-assets.test.js cannot see it: whoever adds
// plugin-host.js to UI_NODE must add plugin-child.js on the same line, or the
// phone's every call fails at fork time with a missing file.
const CHILD = path.join(__dirname, "plugin-child.js");
// The one interface this domain speaks. `daemon` / `cli` mean "a process on the
// session machine, started by rendezvous"; a frontend plugin is neither, and
// installing one here is a refusal rather than a component that can never run.
const INTERFACE = "plugin";

// Names and versions are path segments: these are the traversal gate as much as a
// spelling rule (identical to agent/tools/components.py `_NAME_RE` / `_VERSION_RE`,
// because a version directory here must be readable by the same eyes).
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// ---------------------------------------------------------------- the root --

// Where THIS client keeps what it runs. A machine-local bookkeeping path, beside
// the download cache (`~/.clutch/artifacts`, ui/components.js) and the settings
// mirror (`~/.clutch/settings.json`), and deliberately NOT the session machine's
// root. `%LOCALAPPDATA%/clutch/client` on Windows, for the same reason the host
// uses it: a frozen app has no writable install directory of its own.
function defaultRoot() {
  const override = process.env[ROOT_ENV];
  if (override) return override;
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, "clutch", "client") : path.join(os.homedir(), ".clutch", "client");
}

function componentRoot(root, name) {
  return path.join(root, name);
}

function registryPath(root) {
  return path.join(root, REGISTRY);
}

// --------------------------------------------------------------- the table --

// One table read. A missing file is an EMPTY table, not an error: a client that
// has never installed a plugin has held none, and reading must not create a root
// (reading is not installing). A malformed file IS an error, because guessing
// would silently forget what is on disk — reindex() is the deliberate rebuild.
function readTable(root) {
  const file = registryPath(root);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON — reindex() rebuilds it from the disk`);
  }
  if (!payload || payload.schema !== REGISTRY_SCHEMA || !Array.isArray(payload.components)) {
    throw new Error(`${file} is not a schema-${REGISTRY_SCHEMA} plugin registry`);
  }
  return payload.components
    .filter((r) => r && typeof r.name === "string" && r.name)
    .map((r) => ({
      name: r.name,
      version: String(r.version || ""),
      interface: String(r.interface || ""),
      digest: String(r.digest || ""),
      location: String(r.location || ""),
      disabled: !!r.disabled,
    }));
}

// The table laid down atomically (tmp + rename in the same directory): a reader
// sees the whole old table or the whole new one, never half of either — the same
// discipline `install` uses for a payload, and the reason a crash mid-write
// cannot leave a registry that parses as "nothing is installed".
function writeTable(root, entries) {
  fs.mkdirSync(root, { recursive: true });
  const file = registryPath(root);
  const tmp = path.join(root, `.${REGISTRY}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ schema: REGISTRY_SCHEMA, components: entries }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (ignored) {
      /* the rename never happened: the tmp is all that is left */
    }
    throw e;
  }
}

// One record: which component, which version, what its bytes hash to, where its
// payload is (relative to the root, so the root can be moved or repointed), and
// whether this client is to drive it.
function entryFor(root, name, version, directory, manifest, disabled) {
  let location;
  try {
    location = path.relative(root, directory).split(path.sep).join("/");
  } catch (e) {
    location = directory; // a payload outside the root: recorded as it is, not guessed
  }
  return {
    name,
    version,
    interface: String(manifest.interface || ""),
    digest: String(manifest.digest || ""),
    location,
    disabled: !!disabled,
  };
}

// The payload directory a row names. A location outside the root is recorded
// absolute and used as it stands; one inside is joined, never resolved through
// `..`, so a hand-edited table cannot walk out of the domain.
function directoryOf(root, record) {
  const location = record.location;
  if (!location) return path.join(componentRoot(root, record.name), record.version);
  if (path.isAbsolute(location)) return location;
  const joined = path.join(root, location);
  const inside = path.resolve(joined) === path.resolve(root) || path.resolve(joined).startsWith(path.resolve(root) + path.sep);
  return inside ? joined : path.join(componentRoot(root, record.name), record.version);
}

// ------------------------------------------------------------------ checks --

function checkName(name) {
  if (!NAME_RE.test(String(name || ""))) throw new Error(`bad component name: ${JSON.stringify(name)}`);
}

function checkVersion(version) {
  if (!VERSION_RE.test(String(version || ""))) throw new Error(`bad component version: ${JSON.stringify(version)}`);
}

function checkInterface(manifest) {
  const declared = String((manifest && manifest.interface) || "");
  if (declared !== INTERFACE) {
    throw new Error(
      `manifest declares interface ${JSON.stringify(declared)}, expected ${JSON.stringify(INTERFACE)}: ` +
        "a daemon/cli component belongs to the machine that runs the session, not to this client"
    );
  }
}

// The version ONE install is recorded under: the component's own version with the
// content digest appended — `0.1.0+<hex16>`. Identical to ui/components.js
// `installVersion` (the session domain already reads that shape); a spec that
// names no version keeps the bare digest, because a version would be a claim this
// client cannot back.
function installVersion(named, digest) {
  const short = String(digest || "").slice(0, 16);
  const version = named && typeof named.version === "string" ? named.version.trim() : "";
  if (!version) return short;
  return version.includes("+") ? version : `${version}+${short}`;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// --------------------------------------------------------------- unpacking --

function isArchive(file) {
  return ARCHIVE_SUFFIXES.some((suffix) => file.toLowerCase().endsWith(suffix));
}

// Extract one artifact into `into`. `tar -xf` autodetects compression (GNU tar
// and bsdtar alike); a .zip on a GNU-tar host falls back to `unzip`. A failure is
// the tool's own stderr, not a guess.
function unpack(file, into) {
  const tar = spawnSync("tar", ["-xf", file, "-C", into], { encoding: "utf8" });
  if (tar.status === 0) return;
  if (file.toLowerCase().endsWith(".zip")) {
    const unzip = spawnSync("unzip", ["-q", file, "-d", into], { encoding: "utf8" });
    if (unzip.status === 0) return;
    throw new Error(`could not unpack ${path.basename(file)}: ${(unzip.stderr || unzip.error || "").toString().trim()}`);
  }
  throw new Error(`could not unpack ${path.basename(file)}: ${(tar.stderr || tar.error || "").toString().trim()}`);
}

// A post-extraction fence: nothing in the payload may be a link that leads out of
// it. A tar member can be `../../x` or a symlink to `/etc/passwd`; `tar` does not
// refuse either on every platform, and this payload is about to be `require`d.
// Reached only after extraction (the members cannot be listed portably beforehand),
// so it is a refusal of the RESULT rather than of the request.
function fenceTree(dir) {
  const rootReal = fs.realpathSync(dir);
  const walk = (at) => {
    for (const name of fs.readdirSync(at)) {
      const full = path.join(at, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(full);
        if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
          throw new Error(`refusing a plugin payload with a link out of it: ${path.relative(rootReal, full)}`);
        }
        continue;
      }
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
}

// The installed record: the artifact's own declaration, refined by the request's
// facts (components.py `_merge_declaration`). The request wins on every field it
// names; a package manifest naming a DIFFERENT component is a refusal, because
// the bytes are then not what the request said they were.
function mergeDeclaration(staging, wire) {
  let declared = null;
  try {
    declared = JSON.parse(fs.readFileSync(path.join(staging, MANIFEST), "utf8"));
  } catch (e) {
    declared = null;
  }
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return { ...wire };
  const inner = String(declared.name || "");
  if (inner && inner !== String(wire.name || "")) {
    throw new Error(`the artifact declares itself as ${JSON.stringify(inner)}, not ${JSON.stringify(wire.name)}`);
  }
  return { ...declared, ...wire };
}

// -------------------------------------------------------------------- host --

function createPluginHost(options = {}) {
  const root = options.root || defaultRoot();
  const log = options.log || (() => {});
  const childEntry = options.childEntry || CHILD;

  // What this client holds: the table, and nothing else. A read never touches the
  // root, so a client with no plugins has no root either.
  function list() {
    return readTable(root);
  }

  function versions(name) {
    checkName(name);
    return list()
      .filter((r) => r.name === name)
      .sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
  }

  // The installed declaration + where its entry point is: what the runtime needs,
  // and the only thing a caller may ask the disk about. Newest first, and the
  // first row whose payload really is a plugin wins — a record whose bytes
  // disappeared (a half-copied root, a hand edit, a stale row) is not a component
  // this client can run, and an older version that still loads is better than a
  // null that hides it. Nothing that resolves here is outside the payload: the
  // entry is a path INSIDE it, never a way out.
  function resolve(name) {
    checkName(name);
    for (const record of versions(name)) {
      const dir = directoryOf(root, record);
      let declaration;
      try {
        declaration = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
      } catch (e) {
        continue;
      }
      if (!declaration || typeof declaration !== "object") continue;
      if (String(declaration.name || "") !== name) continue;
      if (String(declaration.interface || "") !== INTERFACE) continue;
      const entry = String(declaration.entry || "");
      if (!entry) continue;
      const full = path.resolve(dir, entry);
      if (full !== path.resolve(dir) && !full.startsWith(path.resolve(dir) + path.sep)) continue;
      if (!fs.existsSync(full)) continue;
      return { record, directory: dir, declaration, entry: full };
    }
    return null;
  }

  // Lay one plugin down, atomically. `artifact` is a DIRECTORY (a checkout, an
  // unpacked payload — the dev path, no digest to measure) or a FILE (an archive
  // unpacked in place, or a single executable installed as <name>) whose sha256
  // must equal `manifest.digest` when that is declared. The staging directory is
  // renamed into place at the end, so a version is either complete or absent; the
  // install drops every OTHER version of that component (a client runs one), and
  // `disabled` rides across because it is about the component, not the version.
  function install({ manifest, artifact, version } = {}) {
    const wire = { ...(manifest || {}) };
    const name = String(wire.name || "");
    checkName(name);
    const ver = String(version || wire.version || "");
    checkVersion(ver);
    checkInterface(wire);
    if (!artifact) throw new Error("install needs an artifact: a directory or a file");
    const stat = fs.statSync(artifact);
    const isDir = stat.isDirectory();
    if (!isDir && !stat.isFile()) throw new Error(`artifact is neither a file nor a directory: ${artifact}`);

    // the gate, before anything is laid down
    if (!isDir && wire.digest) {
      const measured = sha256File(artifact);
      if (measured !== String(wire.digest)) {
        throw new Error(
          `artifact digest ${measured} is not the pinned ${wire.digest}: refusing to install ${name}`
        );
      }
    }

    const target = path.join(componentRoot(root, name), ver);
    const staging = target + INSTALLING;
    const record = { ...wire, name, version: ver };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    try {
      let installed = record;
      if (isDir) {
        fs.cpSync(artifact, staging, { recursive: true });
        installed = mergeDeclaration(staging, record);
      } else if (isArchive(artifact)) {
        unpack(artifact, staging);
        fenceTree(staging);
        installed = mergeDeclaration(staging, record);
      } else {
        // a single-file artifact (a script, a prebuilt runtime): the component's
        // own name is the file, and the manifest says how to start it
        const exe = path.join(staging, name);
        fs.copyFileSync(artifact, exe);
        fs.chmodSync(exe, 0o755);
      }
      fs.writeFileSync(path.join(staging, MANIFEST), JSON.stringify(installed, null, 2) + "\n", "utf8");
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      prune(name, target);
      remember(name, ver, target, installed);
      log(`installed ${name} ${ver} for this client`);
      return entryFor(root, name, ver, target, installed, wasDisabled(name, ver));
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw e;
    }
  }

  function wasDisabled(name, version) {
    return list().some((r) => r.name === name && r.version === version && r.disabled);
  }

  function prune(name, keep) {
    const parent = componentRoot(root, name);
    let children;
    try {
      children = fs.readdirSync(parent);
    } catch (e) {
      return;
    }
    for (const child of children) {
      const full = path.join(parent, child);
      if (full === keep) continue;
      fs.rmSync(full, { recursive: true, force: true });
    }
  }

  // The table learns what the disk now holds LAST: the row is written only after
  // the bytes are in place and the other versions are gone, so a failed install
  // leaves the table saying exactly what is still there.
  //
  // One row per component, not one per version: the install just pruned every
  // other version, so a row for one of them would name bytes that are no longer
  // on disk — a component this client would list and could not run, and (because
  // rows sort by version STRING) possibly a row that shadowed the new one.
  function remember(name, version, directory, installed) {
    const rows = list();
    const stopped = rows.some((r) => r.name === name && r.disabled);
    const kept = rows.filter((r) => r.name !== name);
    writeTable(root, [...kept, entryFor(root, name, version, directory, installed, stopped)]);
  }

  // Take one plugin off this client. Without `version`, the whole component goes
  // (that is what "uninstall this plugin" means) and the verdict names every
  // version that went with it. A version that is not held is a REFUSAL, not an
  // "absent" — the difference between "you asked for the wrong thing" and "there
  // was nothing to remove" is the difference between a typo and a fact.
  function remove(name, version) {
    checkName(name);
    const rows = list();
    const held = rows.filter((r) => r.name === name);
    if (version !== undefined && version !== "") {
      checkVersion(version);
      if (!held.some((r) => r.version === version)) {
        throw new Error(`${name} ${version} is not held by this client`);
      }
    }
    const going = version ? held.filter((r) => r.version === version) : held;
    if (!going.length) return { status: "absent", name };
    for (const record of going) {
      fs.rmSync(directoryOf(root, record), { recursive: true, force: true });
    }
    const gone = new Set(going.map((r) => r.version));
    writeTable(
      root,
      rows.filter((r) => !(r.name === name && gone.has(r.version)))
    );
    // a component directory with nothing left in it is not a component
    try {
      if (!fs.readdirSync(componentRoot(root, name)).length) fs.rmdirSync(componentRoot(root, name));
    } catch (e) {
      /* already gone, or not empty: either way there is nothing to do */
    }
    log(`removed ${name} ${[...gone].join(", ")} from this client`);
    return { status: "removed", name, removed: [...gone] };
  }

  // The one bit that is not a file fact: "held, but not driven". The bytes stay,
  // the row stays listed, and the only thing it decides is whether the tool is
  // offered. It belongs to the COMPONENT (all versions), like the session domain's.
  function setDisabled(name, disabled) {
    checkName(name);
    const rows = list();
    if (!rows.some((r) => r.name === name)) return { status: "absent", name };
    writeTable(
      root,
      rows.map((r) => (r.name === name ? { ...r, disabled: !!disabled } : r))
    );
    return { status: disabled ? "disabled" : "enabled", name, disabled: !!disabled };
  }

  // The deliberate rebuild from the disk. The only path that may make a plugin
  // appear without an install — a root copied from another machine, a hand-placed
  // payload, a lost table. It forgets `disabled` (the disk does not carry it), so
  // a component somebody stopped needs stopping again; that is written down rather
  // than hidden, exactly as in the session domain.
  function reindex() {
    const found = [];
    let names;
    try {
      names = fs.readdirSync(root);
    } catch (e) {
      return found;
    }
    for (const name of names) {
      if (name === REGISTRY || name.startsWith(".")) continue;
      if (!NAME_RE.test(name)) continue;
      let versionsOnDisk;
      try {
        versionsOnDisk = fs.readdirSync(path.join(root, name));
      } catch (e) {
        continue;
      }
      for (const version of versionsOnDisk) {
        if (!VERSION_RE.test(version)) continue;
        const dir = path.join(root, name, version);
        let declaration;
        try {
          declaration = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
        } catch (e) {
          continue;
        }
        if (!declaration || declaration.interface !== INTERFACE || declaration.name !== name) continue;
        found.push(entryFor(root, name, version, dir, declaration, false));
      }
    }
    writeTable(root, found);
    return found;
  }

  // ---------------------------------------------------------------- running --

  // Run ONE tool a plugin publishes, in a forked child, and answer with the
  // plugin's envelope. This is the only entry the target-side host has into this
  // domain: it names a component and a tool, never a path, and it cannot reach a
  // plugin this client has stopped.
  //
  // Refusals are sentences, because every one of them is something the caller
  // would otherwise silently do the wrong thing about: a component that is not
  // here is not "no tools" (the caller must fall back or say why), a STOPPED one
  // must not run, and a tool the declaration does not publish is a bug in the
  // caller, not an empty answer.
  function call(request = {}) {
    const name = String(request.name || "");
    const tool = String(request.tool || "");
    const args = request.args && typeof request.args === "object" ? request.args : {};
    const limit = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : CALL_TIMEOUT_MS;

    if (!tool) return Promise.reject(new Error("call() needs the tool to run"));

    let target;
    try {
      checkName(name);
      target = resolve(name);
      if (!target) {
        const rows = versions(name);
        if (!rows.length) throw new Error(`${name} is not installed for this client`);
        throw new Error(`${name} is held but its payload is unreadable — reindex() or install it again`);
      }
      if (target.record.disabled) {
        throw new Error(`${name} is stopped on this client — start it before calling ${tool}`);
      }
      const declared = Array.isArray(target.declaration.tools) ? target.declaration.tools : [];
      const offered = declared
        .map((t) => (typeof t === "string" ? t : t && t.name))
        .filter((t) => typeof t === "string" && t);
      if (offered.length && !offered.includes(tool)) {
        throw new Error(`${name} publishes no tool ${JSON.stringify(tool)} (it offers ${offered.join(", ")})`);
      }
    } catch (e) {
      return Promise.reject(e);
    }

    return new Promise((settle, fail) => {
      let child;
      try {
        child = fork(childEntry, [], {
          cwd: target.directory,
          env: {
            ...process.env,
            CLUTCH_PLUGIN_DIR: target.directory,
            CLUTCH_PLUGIN_ENTRY: target.entry,
            CLUTCH_PLUGIN_NAME: name,
          },
          // stdout is nobody's: a plugin's console.log must not be able to land
          // in this app's output. stderr is kept — it is the only thing left to
          // say WHY a plugin died before answering.
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
      } catch (e) {
        fail(new Error(`${name} could not be started: ${e.message}`));
        return;
      }

      let done = false;
      let tail = "";
      const timer = setTimeout(() => {
        finish(new Error(`${name}.${tool} did not answer within ${limit}ms — its process was stopped`));
      }, limit);
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          tail = (tail + chunk.toString()).slice(-4096);
        });
        child.stderr.on("error", () => {});
      }

      function finish(err, envelope) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          child.removeAllListeners("message");
        } catch (ignored) {
          /* the child is going away regardless */
        }
        // SIGKILL on POSIX (a plugin that ignores SIGTERM must still die); the
        // default termination on Windows, where SIGKILL is not a signal it has.
        try {
          if (process.platform === "win32") child.kill();
          else child.kill("SIGKILL");
        } catch (ignored) {
          /* already gone */
        }
        if (err) fail(err);
        else settle(envelope);
      }

      child.on("error", (e) => finish(new Error(`${name} could not be started: ${e.message}`)));
      child.on("exit", (code, signal) => {
        const why = tail.trim();
        finish(
          new Error(
            `${name}.${tool} exited (${signal || `code ${code}`}) before answering${why ? `: ${why}` : ""}`
          )
        );
      });
      child.on("message", (message) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") {
          // the call goes out only now: a message sent before the child attached
          // its listener is dropped by node, not queued
          try {
            child.send({ type: "call", tool, args });
          } catch (e) {
            finish(new Error(`${name} could not be handed the call: ${e.message}`));
          }
          return;
        }
        if (message.type === "error") {
          finish(new Error(`${name}.${tool}: ${message.error || "the plugin failed"}`));
          return;
        }
        if (message.type === "result") {
          const envelope = message.envelope;
          if (!envelope || typeof envelope.content !== "string") {
            finish(new Error(`${name}.${tool} answered with a malformed envelope from its runtime`));
            return;
          }
          finish(null, { content: envelope.content, error: !!envelope.error });
        }
      });
    });
  }

  return { root, list, versions, resolve, install, remove, setDisabled, reindex, call };
}

module.exports = {
  MANIFEST,
  REGISTRY,
  REGISTRY_SCHEMA,
  ROOT_ENV,
  INTERFACE,
  ARCHIVE_SUFFIXES,
  CALL_TIMEOUT_MS,
  defaultRoot,
  registryPath,
  installVersion,
  createPluginHost,
};
