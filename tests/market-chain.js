// Not a test of its own: the half of tests/market.test.js that has to say what a
// market read LEFT ON THIS MACHINE. That needs a HOME of its own, so it runs in a
// child process with HOME pointed at a scratch directory (ui/components.js
// resolves its artifact cache from os.homedir() at require time, so a process
// cannot adopt a new HOME after it has started either).
//
// It prints ONE JSON line: whatever ui/components.js readIndex() answered, plus
// the two facts a caller cannot see from outside — whether the failure was the
// network (unreachable), and whether anything at all was written under this
// machine's HOME (homeFiles). The interesting answer is an EMPTY homeFiles: a
// read that kept its bytes would be the second, undatable copy of the market this
// build deleted, and `homeFiles` is how that absence is checked instead of
// assumed.
//
// Run: node tests/market-chain.js <url | path>   (nothing = the real index URL)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const components = require("../ui/components");

// every file under dir, relative to it — expected to stay empty
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    let items = [];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return; // not there: nothing was written below it
    }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

async function main() {
  const given = process.argv[2] || null;
  const read = await components.readIndex(given ? { index: given } : {});
  process.stdout.write(
    JSON.stringify({
      entries: read.entries.length,
      unreachable: read.unreachable,
      errors: read.errors.map((e) => e.reason),
      homeFiles: filesUnder(os.homedir()),
      indexUrl: components.INDEX_URL,
      snapshot: components.SNAPSHOT_FILE, // undefined: there is no shipped copy
    }) + "\n"
  );
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ fatal: (e && e.message) || String(e) }) + "\n");
  process.exit(1);
});
