// Artifact-provider seam (R3): the desktop default builds/locates artifacts on
// this machine; a registered provider (the future Android downloader, N3) must
// receive the calls untouched — ssh-tunnel.js cannot tell the difference.
// Run: node tests/artifact-provider-test.js
const assert = require("assert");
const { ensureBundle, ensurePyLibsTar, setArtifactProvider } = require("../ui/server-bundle");

async function main() {
  // shape validation: a provider without the pylibs seam is a config error
  assert.throws(() => setArtifactProvider({}), /must implement ensurePyLibsTar/, "provider is validated");

  const calls = [];
  setArtifactProvider({
    ensureBundle: async () => {
      calls.push("bundle");
      return { server: "s", supervisor: "v", version: "abc" };
    },
    ensurePyLibsTar: async (target) => {
      calls.push(["pylibs", target]);
      return { path: "/tmp/x.tar.gz", version: "deadbeef" };
    },
  });

  const b = await ensureBundle();
  assert.deepStrictEqual(b, { server: "s", supervisor: "v", version: "abc" }, "ensureBundle routes to the provider");

  const t = await ensurePyLibsTar({ os: "Linux", arch: "aarch64", libc: "musl", pyver: "3.12" });
  assert.strictEqual(t.version, "deadbeef", "ensurePyLibsTar routes to the provider");
  assert.deepStrictEqual(
    calls[1],
    ["pylibs", { os: "Linux", arch: "aarch64", libc: "musl", pyver: "3.12" }],
    "the remote probe target passes through untouched"
  );

  // a sync provider is legal too (the seam awaits whatever comes back)
  setArtifactProvider({ ensurePyLibsTar: () => ({ path: "p", version: "v1" }) });
  assert.strictEqual((await ensurePyLibsTar({})).version, "v1", "sync providers work");

  // back to desktop defaults: no provider registered, nothing routed
  setArtifactProvider(null);
  assert.deepStrictEqual(calls.length, 2, "no further provider calls after reset");

  console.log("artifact provider: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
