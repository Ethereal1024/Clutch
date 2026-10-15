// The pylibs tar lands on the far side by REPLACE, never by merge — and the
// install gate asks the tree, not only the VERSION file.
//
// Everything here is driven by the REAL shell, the REAL tar and the REAL python
// on this host: `pylibsInstallCmd` is a shell command, and the defect it closes
// was in what a shell did with a tar (tarfile.extractall over a live tree adds
// and overwrites, and NEVER deletes — so every file the new release does not
// ship stays behind, and two generations of one package on one tree is a tree no
// import survives). A fake shell could not show that, so this runner builds real
// tars and runs the command the shipped code builds.
//
//   1. the command never unpacks over the live trees, verifies BOTH trees before
//      it swaps anything, and leaves no staging or `.old` tree behind;
//   2. A then B: the previous generation's dist-info and the modules B does not
//      ship are GONE after installing B (the merge is what the field died of);
//   3. a tar that carries half of itself (no `agent/`) or a corrupt upload fails
//      with the live tree byte-for-byte what it was;
//   4. the real TREE_PROBE_CMD, against real trees, says OK / DUP:… /
//      IMPORT:SystemError / NONE / NOPY — including the field's exact shape
//      (metadata older than the extension module beside it → SystemError at
//      import) — and pylibsTreeSound reads exactly those as the gate does.
//
// Run: node tests/pylibs-install-merge-test.js

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { check, summary } = require("./harness");
const {
  PROBE_CMD,
  TREE_PROBE_CMD,
  parseProbe,
  pylibsInstallCmd,
  pylibsTreeSound,
} = require("../ui/tunnel-bootstrap");

const BOOTSTRAP_SRC = fs.readFileSync(path.join(__dirname, "..", "ui", "tunnel-bootstrap.js"), "utf8");

// bash is dialed by ABSOLUTE path once it has been found: one check below runs
// the probe with PATH emptied (to reproduce "no python3 to ask with"), and a
// relative "bash" would be looked up in exactly that empty PATH.
const BASH = (spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout || "").trim();

function have(tool) {
  return spawnSync(BASH || "bash", ["-c", "command -v " + tool], { encoding: "utf8" }).status === 0;
}

// the shell command, run the way the far side runs it (one /bin/sh-style string)
function run(cmd, env) {
  return spawnSync(BASH || "bash", ["-c", cmd], {
    encoding: "utf8",
    env: Object.assign({}, process.env, env || {}),
  });
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// What is in a tree, byte for byte: "did the failed install touch the live
// trees?" is a question about every file in them, and one byte of one extension
// module is the whole difference between a working far side and the field's
// SystemError. The uploaded tar is skipped: it is the upload, not the tree.
function snapshot(root, skipTop = []) {
  const out = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (!rel && skipTop.includes(e.name)) continue;
      if (e.isDirectory()) {
        out[r] = "dir";
        walk(p, r);
      } else if (e.isSymbolicLink()) {
        out[r] = "link:" + fs.readlinkSync(p);
      } else {
        const buf = fs.readFileSync(p);
        out[r] = buf.length + ":" + crypto.createHash("sha256").update(buf).digest("hex");
      }
    }
  };
  if (fs.existsSync(root)) walk(root, "");
  return out;
}

function sameTree(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// a tar whose top level is exactly the trees asked for, built the way the
// release script builds its own: `site-packages/` and `agent/` at the root,
// entries named relative to them.
function buildTar(tarPath, entries) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-tar-"));
  for (const [rel, content] of Object.entries(entries)) {
    const p = path.join(stage, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const tops = [...new Set(Object.keys(entries).map((r) => r.split("/")[0]))];
  const r = run(`tar -czf ${shq(tarPath)} -C ${shq(stage)} ${tops.map(shq).join(" ")}`);
  fs.rmSync(stage, { recursive: true, force: true });
  if (r.status !== 0) throw new Error("tar -czf failed: " + r.stderr);
  return tarPath;
}

// the far side's half of the install: the tar arrives as pylibs.tar.gz beside
// the trees, then the shipped command runs
function installInto(dir, tarPath) {
  fs.copyFileSync(tarPath, path.join(dir, "pylibs.tar.gz"));
  return run(pylibsInstallCmd(dir));
}

async function main() {
  if (process.platform === "win32") {
    console.log("SKIP: the pylibs install is a POSIX shell command; this host has no bash");
    return;
  }
  for (const tool of ["bash", "python3", "tar"]) {
    if (!have(tool)) {
      console.log(`SKIP: no ${tool} on this host; the pylibs install/probe needs real ones`);
      return;
    }
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-pylibs-install-"));
  const dir = path.join(base, ".clutch-server"); // ${home}/.clutch-server, as the caller builds it
  fs.mkdirSync(dir, { recursive: true });

  // ---- 1. the shape of the command: stage, verify BOTH trees, swap ----
  const cmd = pylibsInstallCmd(dir);
  check(
    !cmd.includes(`extractall('${dir}')`),
    "the tar is never unpacked over the live trees (no extractall into the server dir)"
  );
  check(
    cmd.includes(`extractall('${dir}/pylibs.stage')`),
    "…it is unpacked into a staging directory on the same filesystem (the swap can be a rename)"
  );
  const verifyAt = cmd.indexOf(`test -d ${dir}/pylibs.stage/site-packages -a -d ${dir}/pylibs.stage/agent`);
  check(verifyAt > -1, "…and BOTH trees of the tar are verified after the unpack (site-packages AND agent)");
  check(
    verifyAt > cmd.indexOf("extractall") && verifyAt < cmd.indexOf("mv "),
    "…between the unpack and the first move: a tar that carries half of itself installs nothing"
  );
  check(
    cmd.indexOf("mv ") < cmd.indexOf("rm -f"),
    "…and the upload is removed last, once both trees have landed"
  );
  check(
    cmd.includes(`${dir}/pylibs.tar.gz`),
    "the command reads the tar from where installServer uploads it"
  );
  check(
    BOOTSTRAP_SRC.includes("uploadFile(artifact, `${dir}/pylibs.tar.gz`)"),
    "…which is the path the production upload names (asserted on the source, so the two cannot drift)"
  );
  check(
    cmd.indexOf(`rm -rf ${dir}/pylibs.stage`) === 0,
    "a leftover staging tree from a previous failed attempt is cleared first"
  );

  // ---- 2. A then B: an install REPLACES, it does not merge ----
  const tarA = buildTar(path.join(base, "a.tar.gz"), {
    "site-packages/pkg_a/__init__.py": "__version__ = '1.0.0'\n",
    "site-packages/pkg_a/only_in_a.py": "# dropped in 1.1.0\n",
    "site-packages/pkg_a-1.0.0.dist-info/METADATA": "Name: pkg_a\nVersion: 1.0.0\n",
    "site-packages/pkg_core/__init__.py": "CORE = '1'\n",
    "site-packages/pkg_core-0.9.0.dist-info/METADATA": "Name: pkg_core\nVersion: 0.9.0\n",
    "agent/supervisor.py": "# far side code, generation A\n",
    "agent/old_only.py": "# dropped from the release\n",
    "agent/marker.txt": "A\n",
  });
  const first = installInto(dir, tarA);
  check(first.status === 0, "the first install lands (exit " + first.status + ") " + (first.stderr || "").trim());
  check(
    fs.existsSync(path.join(dir, "site-packages/pkg_a-1.0.0.dist-info")) &&
      fs.existsSync(path.join(dir, "agent/marker.txt")),
    "…leaving both trees in place"
  );
  check(!fs.existsSync(path.join(dir, "pylibs.tar.gz")), "…and the uploaded tar removed");
  check(!fs.existsSync(path.join(dir, "pylibs.stage")), "…with no staging tree left behind");

  const tarB = buildTar(path.join(base, "b.tar.gz"), {
    "site-packages/pkg_a/__init__.py": "__version__ = '1.1.0'\n",
    "site-packages/pkg_a-1.1.0.dist-info/METADATA": "Name: pkg_a\nVersion: 1.1.0\n",
    "site-packages/pkg_core/__init__.py": "CORE = '2'\n",
    "site-packages/pkg_core-1.0.0.dist-info/METADATA": "Name: pkg_core\nVersion: 1.0.0\n",
    "agent/supervisor.py": "# far side code, generation B\n",
    "agent/marker.txt": "B\n",
  });
  const second = installInto(dir, tarB);
  check(second.status === 0, "the second install lands over the first (exit " + second.status + ")");
  const sp = path.join(dir, "site-packages");
  const distInfos = fs.readdirSync(sp).filter((n) => n.endsWith(".dist-info")).sort();
  check(
    JSON.stringify(distInfos) === JSON.stringify(["pkg_a-1.1.0.dist-info", "pkg_core-1.0.0.dist-info"]),
    "one generation of metadata per project, and no more (" + distInfos.join(", ") + ")"
  );
  check(
    !fs.existsSync(path.join(sp, "pkg_a/only_in_a.py")),
    "a module the new release does not ship is GONE, not merged beside it (the field's shape)"
  );
  check(
    !fs.existsSync(path.join(dir, "agent/old_only.py")),
    "…and the far side's own tree is replaced the same way, not merged"
  );
  check(
    fs.readFileSync(path.join(dir, "agent/marker.txt"), "utf8") === "B\n" &&
      fs.readFileSync(path.join(sp, "pkg_core/__init__.py"), "utf8").includes("'2'"),
    "…so what is live is B, module for module"
  );
  check(
    ["pylibs.stage", "site-packages.old", "agent.old"].every((n) => !fs.existsSync(path.join(dir, n))),
    "no staging or .old tree survives a successful install"
  );

  // ---- 3. half a tar, or a corrupt one, changes nothing ----
  const quiet = ["pylibs.tar.gz"]; // the upload itself, not the tree
  const good = snapshot(dir, quiet);
  const half = buildTar(path.join(base, "half.tar.gz"), {
    "site-packages/pkg_a/__init__.py": "__version__ = '9.9.9'\n",
    "site-packages/pkg_a-9.9.9.dist-info/METADATA": "Name: pkg_a\nVersion: 9.9.9\n",
  });
  const halfRes = installInto(dir, half);
  check(
    halfRes.status !== 0,
    "a tar that carries no agent/ FAILS the install instead of landing half of itself"
  );
  check(
    !fs.existsSync(path.join(sp, "pkg_a-9.9.9.dist-info")) && fs.existsSync(path.join(sp, "pkg_a-1.1.0.dist-info")),
    "…so the live tree still holds the release that was working"
  );
  check(
    !fs.existsSync(path.join(dir, "pylibs.stage")),
    "…and the half-unpacked staging tree goes away with the failure (the far side is a phone)"
  );
  check(sameTree(good, snapshot(dir, quiet)), "…byte for byte: nothing from the half-tar reached it");

  const broken = path.join(base, "broken.tar.gz");
  fs.writeFileSync(broken, "this is not a gzip stream\n");
  const brokenRes = installInto(dir, broken);
  check(brokenRes.status !== 0, "a corrupt upload fails the install");
  check(sameTree(good, snapshot(dir, quiet)), "…and is not a way to lose a working tree either");
  check(
    /rc=\$\?; rm -rf .*pylibs\.stage; test \$rc -eq 0$/.test(cmd),
    "…and the exit status the caller reads survives that cleanup"
  );
  check(
    /const landed = await remoteExec\(pylibsInstallCmd\(dir\)\)/.test(BOOTSTRAP_SRC) &&
      /if \(landed\.code !== 0\)/.test(BOOTSTRAP_SRC),
    "the caller asks how the install went before it writes the VERSION marker (a marker over a tree that did not land is the lie)"
  );
  check(
    BOOTSTRAP_SRC.indexOf("if (landed.code !== 0)") < BOOTSTRAP_SRC.indexOf("> ${dir}/VERSION"),
    "…on the path that cannot reach the marker write when the install failed"
  );

  // ---- 4. what the tree says about itself (the real probe, real trees) ----
  //
  // The gate's second half is only as good as what the far side is asked, so the
  // question is asked here the way it is asked there: PYTHONPATH set to the
  // remote's site-packages, HOME pointing at the tree under test.
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-tree-probe-"));
  const spDir = path.join(probeHome, ".clutch-server", "site-packages");
  const verdict = (env) => parseProbe(run(TREE_PROBE_CMD, Object.assign({ HOME: probeHome }, env)).stdout).pylibsTree;

  check(verdict() === "NONE", "a VERSION file over a tree that is not there reads NONE (" + verdict() + ")");

  fs.mkdirSync(path.join(spDir, "pydantic"), { recursive: true });
  fs.mkdirSync(path.join(spDir, "pydantic_core"), { recursive: true });
  fs.mkdirSync(path.join(spDir, "pydantic-2.13.5.dist-info"), { recursive: true });
  fs.mkdirSync(path.join(spDir, "pydantic_core-2.46.5.dist-info"), { recursive: true });
  fs.writeFileSync(path.join(spDir, "pydantic", "__init__.py"), "");
  fs.writeFileSync(path.join(spDir, "pydantic_core", "__init__.py"), "");
  const ok = verdict();
  check(ok === "OK", `a tree that imports its wheels with one generation each reads OK (${ok})`);

  // the field's tree: the OLD generation's metadata is still there beside the new
  // one — two generations of pydantic_core on one tree, which is what a merge
  // leaves and what the names alone can see
  const dup = path.join(spDir, "pydantic_core-2.50.1.dist-info");
  fs.mkdirSync(dup, { recursive: true });
  const dupVerdict = verdict();
  check(
    dupVerdict === "DUP:pydantic_core",
    `two generations of one project on one tree are named as such (${dupVerdict})`
  );
  check(pylibsTreeSound(dupVerdict) === false, "…and the gate does not hand our code to a tree like that");

  // the metadata cleaned up is not the tree cleaned up: the module left behind by
  // the overwrite still cannot be imported beside its new core (the field's
  // SystemError), and the import is the only witness left
  fs.rmSync(dup, { recursive: true, force: true });
  fs.writeFileSync(
    path.join(spDir, "pydantic", "__init__.py"),
    "raise SystemError('pydantic 2.13.5 requires pydantic_core 2.13.x, got 2.50.1')\n"
  );
  const importVerdict = verdict();
  check(
    importVerdict === "IMPORT:SystemError",
    `the field's tree — clean metadata, mixed modules — reads ${importVerdict}`
  );
  check(pylibsTreeSound(importVerdict) === false, "…and is an install, never a no-op");

  // "no python3 to ask with" is NOT a verdict about the tree: it is the one
  // answer an install would be refused on anyway (chooseStrategy has no pylibs
  // path without python3), so defaulting it to "sound" cannot skip a healthy
  // install — and defaulting it to "unsound" would install on every connect.
  const nopy = verdict({ PATH: "/nonexistent" });
  check(nopy === "NOPY", `a remote with no python3 to ask says NOPY (${nopy})`);

  check(pylibsTreeSound("OK") === true && pylibsTreeSound("NONE") === false, "pylibsTreeSound: OK is sound, NONE is not");
  check(
    pylibsTreeSound("NOPY") === true && pylibsTreeSound("") === true && pylibsTreeSound(undefined) === true,
    "an exec that never answered is not read as a broken tree (it is not an answer about the tree at all)"
  );

  // the probe rides in the SAME exec as the other sections: one round trip per
  // connect, and nothing in its program contains the section delimiter
  check(
    PROBE_CMD.includes(TREE_PROBE_CMD),
    "the tree probe is one of the probe's own sections (no extra round trip on a phone link)"
  );
  check(
    PROBE_CMD.indexOf("__ART__") < PROBE_CMD.indexOf(TREE_PROBE_CMD) &&
      PROBE_CMD.indexOf(TREE_PROBE_CMD) < PROBE_CMD.indexOf("__NET__"),
    "…between the artifact listing and the network check"
  );
  const program = TREE_PROBE_CMD.slice(TREE_PROBE_CMD.indexOf("python3 -c '") + 11, TREE_PROBE_CMD.lastIndexOf("'"));
  check(!program.includes("__"), "…and nothing it prints contains __, so no section can be split in half");
  const parsed = parseProbe("__ART__\nbundle\n__TREE__\nDUP:pydantic_core\n__NET__\nOK\n__TMP__\nYES\n");
  check(
    parsed.pylibsTree === "DUP:pydantic_core" && parsed.internet === true && parsed.tmpWritable === true,
    "its answer is parsed without disturbing the sections around it"
  );

  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(probeHome, { recursive: true, force: true });

  summary("pylibs-install-merge", "the tar replaces the trees, and the gate reads the tree");
}

main().catch((e) => {
  console.error("runner failed:", (e && e.stack) || e);
  process.exit(1);
});
