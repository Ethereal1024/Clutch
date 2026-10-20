// Not a test of its own: the half of tests/market.test.js that needs a HOME of
// its own. ui/components.js resolves the index cache (~/.clutch/market/index.json)
// from os.homedir() at require time, so a chain that starts at "this machine has
// no cache yet" and ends at "it has one" cannot be two states of one process.
//
// It prints ONE JSON line: whatever ui/components.js readIndex() answered, with
// the two facts this runner cannot see from outside (did the read hit the
// network at all, and which place answered).
//
// Run: node tests/market-chain.js <url | path> [cacheBust]
"use strict";

const fs = require("fs");
const path = require("path");

const components = require("../ui/components");

async function main() {
  const given = process.argv[2] || null;
  const read = await components.readIndex(given ? { index: given } : {});
  const cache = path.join(require("os").homedir(), ".clutch", "market", "index.json");
  process.stdout.write(
    JSON.stringify({
      entries: read.entries.length,
      origin: read.origin,
      note: read.note,
      unreachable: read.unreachable,
      errors: read.errors,
      cacheWritten: fs.existsSync(cache),
      indexUrl: components.INDEX_URL,
      snapshot: components.SNAPSHOT_FILE,
    }) + "\n"
  );
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ fatal: (e && e.message) || String(e) }) + "\n");
  process.exit(1);
});
