"use strict";

// scripts/pack-pylibs-tar.py owns the ONE invariant the whole pylibs supply
// line leans on: the tar's sha256 is a fact about its CONTENT.
//
// Both ends read that hash as a version, not as a checksum:
//   * the release publishes it as the asset name and as the index's `version`
//     (softprops/action-gh-release replaces by name, so a hash that moves
//     without a content change renames the asset and orphans the old one);
//   * the remote writes it to ~/.clutch-server/VERSION and reinstalls iff it
//     differs (ssh-tunnel), so bytes that move on their own re-upload the whole
//     stack on every session and every release.
//
// v0.2.0 is the worked example: run #83 and run #84 built the same 1974 files
// on the same tree and published two different names for them
// (…-37df4cf252b7cb0a vs …-8ef08185757ac59d). `diff` of the member lists is
// empty — only the ORDER differed, because `tar -C dir -cf - agent
// site-packages` walks readdir order and a fresh checkout hands back a
// different one. The old code also pinned mtimes with `touch` but left uid/gid,
// owner names and the staging tree's umask in the archive.
//
// So the fixture is the failure itself: the same tree built twice with the
// files CREATED in opposite orders and stamped with different mtimes must pack
// to one sha256. tests/android-pylibs-path-test.js checks the neighbouring
// claim (two consecutive builds of a real target agree) but cannot see this
// one: consecutive builds copy from the same directory, so readdir answers the
// same both times.
//
// Run: node tests/pylibs-tar-pack-test.js  (python3 + the repo's own script, no
// venv, no network)

const { check, summary } = require("./harness");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const PACK = path.join(REPO, "scripts", "pack-pylibs-tar.py");
const PY = "python3";

// dirs, sources, a compiled extension (mode-preserving: the wheel puts +x on
// it nowhere, but a client's checkout may) and an executable-ish file
const FILES = {
  "agent/__init__.py": "VERSION = 1\n",
  "agent/server.py": "def main():\n    return 0\n",
  "agent/tools/__init__.py": "",
  "agent/tools/shell.py": "def run(cmd):\n    return cmd\n",
  "site-packages/openai/__init__.py": "from .client import Client\n",
  "site-packages/openai/client.py": "class Client:\n    pass\n",
  "site-packages/openai/_core.so": "\x7fELF not really\n",
  "site-packages/openai-3.5.0.dist-info/METADATA": "Name: openai\nVersion: 3.5.0\n",
};

const TREE = "/tmp/android/pylibs";

// Write the same tree into `root`, creating members in `order` (reverse order
// is what a differently-built checkout looks like) and stamping every mtime
// with `stamp`.
function stage(root, order, stamp) {
  for (const name of order) {
    const dest = path.join(root, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, FILES[name]);
    if (name.endsWith("_core.so")) fs.chmodSync(dest, 0o755);
    fs.utimesSync(dest, stamp, stamp);
  }
  // directories too: tar used to carry their mtimes, and a directory touched
  // after its children is the normal shape of a `cp -r`
  for (const dir of ["agent", "agent/tools", "site-packages", "site-packages/openai",
    "site-packages/openai-3.5.0.dist-info"]) {
    fs.utimesSync(path.join(root, dir), stamp + 3600, stamp + 3600);
  }
}

function pack(src, out) {
  const r = spawnSync(PY, [PACK, src, out], { encoding: "utf8" });
  if (r.status !== 0) {
    console.log("--- pack-pylibs-tar.py failed, output: ---");
    console.log(((r.stdout || "") + (r.stderr || "")).split("\n").slice(-25).join("\n"));
  }
  return { r, stderr: `${r.stdout || ""}${r.stderr || ""}` };
}

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// Members exactly as the archive states them — the metadata is the assertion,
// so it is read from the tar rather than inferred.
function members(tar) {
  const code = [
    "import json, sys, tarfile",
    "tf = tarfile.open(sys.argv[1])",
    "print(json.dumps([[m.name, m.mtime, m.uid, m.gid, m.uname, m.gname,",
    "                   m.mode, m.type.decode()] for m in tf.getmembers()]))",
  ].join("\n");
  const r = spawnSync(PY, ["-c", code, tar], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cannot list ${tar}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function readdirOrder(root) {
  return fs.readdirSync(root);
}

async function main() {
  if (spawnSync(PY, ["-c", "import tarfile"]).status !== 0) {
    console.log(`SKIP: no ${PY} on this host; the packer is a python script`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "clutch-pylibs-pack-"));
  try {
    const names = Object.keys(FILES);
    const a = path.join(work, "a", TREE);
    const b = path.join(work, "b", TREE);
    stage(a, names, 1700000000);                                  // oldest → newest
    stage(b, [...names].reverse(), 1234567890);                   // reversed + a different clock

    // the fixture is only the failure if the filesystem really does hand the
    // two trees back in different orders (it does on the runners; a filesystem
    // that sorts readdir cannot reproduce the bug, and says so here)
    const orderA = readdirOrder(path.join(a, "site-packages"));
    const orderB = readdirOrder(path.join(b, "site-packages"));
    console.log(
      orderA.join(" ") === orderB.join(" ")
        ? `NOTE: readdir is sorted on this filesystem (${orderA.join(" ")}), so these two trees\n` +
            "      cannot disagree on walk order here; the member-order assertion below still runs"
        : `readdir differs between the two trees: ${orderA.join(" ")} vs ${orderB.join(" ")}`
    );

    const tarA = path.join(work, "a.tar.gz");
    const tarB = path.join(work, "b.tar.gz");
    const pa = pack(a, tarA);
    check(pa.r.status === 0, "the packer exits 0 on a staged tree");
    if (pa.r.status !== 0) return;
    check(/pylibs tar packed: .* members\)/.test(pa.stderr), "the packer reports what it packed");
    const pb = pack(b, tarB);
    check(pb.r.status === 0, "and on the same tree created in the opposite order");
    if (pb.r.status !== 0) return;

    const hash = sha256File(tarA);
    check(
      hash === sha256File(tarB),
      "creation order + mtimes do not reach the bytes: one sha256 for both trees"
    );

    // the mechanism behind that equality, asserted directly: the archive lists
    // its members sorted, so no walk order can leak into the bytes
    const aMembers = members(tarA);
    const bMembers = members(tarB);
    const aNames = aMembers.map((m) => m[0]);
    check(
      JSON.stringify(aNames) === JSON.stringify([...aNames].sort()),
      "members are listed in sorted order (readdir order never reaches the tar)"
    );
    check(
      JSON.stringify(aNames) === JSON.stringify(bMembers.map((m) => m[0])),
      "both trees yield the same member list, in the same order"
    );
    check(
      aNames[0] === "agent" && aNames.includes("agent/") === false &&
        aNames.includes("site-packages/openai/client.py"),
      "members are the tree's own paths (agent …, site-packages …), not './'/absolute"
    );

    check(
      aMembers.every((m) => m[1] === 0),
      "every member is stamped mtime 0 (the build clock never ships)"
    );
    check(
      aMembers.every((m) => m[2] === 0 && m[3] === 0 && m[4] === "" && m[5] === ""),
      "every member is uid/gid 0 with no owner names (the runner's ids never ship)"
    );
    const modeOf = (n) => aMembers.find((m) => m[0] === n)[6];
    check(
      modeOf("agent") === 0o755 && modeOf("agent/server.py") === 0o644,
      "dirs are 0755 and plain files 0644, whatever the staging umask was"
    );
    check(
      modeOf("site-packages/openai/_core.so") === 0o755,
      "an executable file keeps its bit (0755), so the normalization is not a blunt 0644"
    );

    // a hash that ignores content would pass everything above
    const before = fs.readFileSync(tarA);
    fs.appendFileSync(path.join(a, "agent/__init__.py"), "# edited\n");
    fs.utimesSync(path.join(a, "agent"), 1700000000, 1700000000);
    const edited = path.join(work, "edited.tar.gz");
    check(pack(a, edited).r.status === 0, "the packer runs again over an edited tree");
    check(
      sha256File(edited) !== hash,
      "a content change does move the hash (it is a content hash, not a constant)"
    );
    check(before.length > 0, "the first tar is non-empty");

    // and the packing itself is stable: re-packing the SAME tree is idempotent
    const again = path.join(work, "again.tar.gz");
    check(pack(b, again).r.status === 0, "the packer runs a third time");
    check(sha256File(again) === hash, "re-packing an untouched tree reproduces its bytes");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main()
  .then(() => summary("pylibs-tar-pack"))
  .catch((e) => {
    console.log("FAIL: uncaught: " + ((e && e.stack) || e));
    process.exit(1);
  });
