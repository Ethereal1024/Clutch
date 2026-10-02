// Artifact-provider seam (R3): the desktop default builds/locates artifacts on
// this machine; a registered provider (the Android downloader, N3) must receive
// the calls untouched — ssh-tunnel.js cannot tell the difference. The seam has
// two questions and both are required: WHICH artifact this release ships
// (resolvePyLibsVersion — the install gate) and its BYTES (ensurePyLibsTar — an
// upload); a provider that can answer the first without transferring anything
// must answer it without transferring anything (report #5).
// Run: node tests/artifact-provider-test.js
const assert = require("assert");
const { ensureBundle, ensurePyLibsTar, resolvePyLibsVersion, setArtifactProvider } = require("../ui/server-bundle");

async function main() {
  // shape validation: a provider missing either half of the pylibs seam is a
  // config error, not a provider that silently falls back to the desktop build
  assert.throws(() => setArtifactProvider({}), /must implement ensurePyLibsTar/, "provider is validated");
  assert.throws(
    () => setArtifactProvider({ ensurePyLibsTar: async () => ({}) }),
    /must implement resolvePyLibsVersion/,
    "the version question is part of the seam"
  );

  const calls = [];
  setArtifactProvider({
    ensureBundle: async () => {
      calls.push("bundle");
      return { server: "s", supervisor: "v", version: "abc" };
    },
    resolvePyLibsVersion: async (target) => {
      calls.push(["version", target]);
      return "deadbeef";
    },
    ensurePyLibsTar: async (target) => {
      calls.push(["pylibs", target]);
      return { path: "/tmp/x.tar.gz", version: "deadbeef" };
    },
  });

  const b = await ensureBundle();
  assert.deepStrictEqual(b, { server: "s", supervisor: "v", version: "abc" }, "ensureBundle routes to the provider");

  const target = { os: "Linux", arch: "aarch64", libc: "musl", pyver: "3.12" };
  assert.strictEqual(await resolvePyLibsVersion(target), "deadbeef", "resolvePyLibsVersion routes to the provider");
  assert.deepStrictEqual(calls[1], ["version", target], "the remote probe target passes through untouched");

  const t = await ensurePyLibsTar(target);
  assert.strictEqual(t.version, "deadbeef", "ensurePyLibsTar routes to the provider");
  assert.deepStrictEqual(calls[2], ["pylibs", target], "the same target reaches the bytes question");

  // a sync provider is legal too (the seam awaits whatever comes back)
  setArtifactProvider({
    resolvePyLibsVersion: () => "v1",
    ensurePyLibsTar: () => ({ path: "p", version: "v1" }),
  });
  assert.strictEqual(await resolvePyLibsVersion({}), "v1", "sync providers work");
  assert.strictEqual((await ensurePyLibsTar({})).version, "v1", "sync providers work for the bytes too");

  // back to desktop defaults: no provider registered, nothing routed
  setArtifactProvider(null);
  assert.deepStrictEqual(calls.length, 3, "no further provider calls after reset");

  console.log("artifact provider: all checks passed");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e && (e.stack || e.message || e));
    process.exit(1);
  });
