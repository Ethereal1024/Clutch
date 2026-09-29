// Strategy selection for the remote bootstrap (the "install server" path).
// Run: node tests/remote-strategy-test.js
//
// Regression: the choice used to compare CPU arch ONLY, so a Windows or mac
// client facing a same-arch Linux remote picked the `bundle` strategy and
// tried to build the server binaries locally — "bundle build failed" on
// Windows, and a useless foreign binary even where the build succeeded.
// The bundle is valid only for a same-OS *and* same-arch remote; every
// cross-platform remote with a python3 goes through pylibs.

"use strict";

const fs = require("fs");
const path = require("path");
const { chooseStrategy } = require("../ui/ssh-tunnel");
const {
  resolveBash,
  platformTag,
  setArtifactProvider,
  hasLocalBundle,
} = require("../ui/server-bundle");
const { check, summary } = require("./harness");

const probe = (os, arch, python) => ({ os, arch, python: python || "" });

// 1. THE regression: Windows client -> Linux x86_64 remote (the reported case)
check(
  chooseStrategy(probe("Linux", "x86_64", "3.10"), "windows-x86_64") === "pylibs",
  "win->linux x86_64 (py3) picks pylibs, not bundle"
);

// 2. arch matches but OS differs: pylibs (this also used to pick bundle)
check(
  chooseStrategy(probe("Linux", "arm64", "3.12"), "darwin-arm64") === "pylibs",
  "mac arm64 -> linux arm64 (py3) picks pylibs"
);

// 3. same platform: bundle is back in business
check(
  chooseStrategy(probe("Linux", "x86_64", "3.10"), "linux-x86_64") === "bundle",
  "linux x86_64 -> linux x86_64 picks bundle"
);
check(
  chooseStrategy(probe("Darwin", "arm64"), "darwin-arm64") === "bundle",
  "mac arm64 -> darwin arm64 picks bundle (even without remote python)"
);
check(
  chooseStrategy(probe("Windows", "x86_64", "3.11"), "windows-x86_64") === "bundle",
  "win x86_64 -> windows x86_64 picks bundle"
);

// 4. uname -s capitalization must not matter
check(
  chooseStrategy(probe("LINUX", "x86_64", "3.10"), "linux-x86_64") === "bundle" &&
    chooseStrategy(probe("linux", "aarch64", "3.10"), "linux-x86_64") === "pylibs",
  "os comparison is case-insensitive"
);

// 5. no remote python3 and no same-platform bundle -> null (SSH-tools fallback)
check(
  chooseStrategy(probe("Linux", "arm64"), "windows-x86_64") === null,
  "linux arm64 without python3 from a win client -> null"
);
check(
  chooseStrategy(probe("", "x86_64", "3.8"), "linux-x86_64") === "pylibs",
  "missing os field with python -> pylibs"
);
check(
  chooseStrategy(probe("", "x86_64"), "linux-x86_64") === null,
  "missing os field without python -> null"
);

// 6. aarch64 vs x86_64 naming from uname -m
check(
  chooseStrategy(probe("Linux", "aarch64", "3.10"), "linux-x86_64") === "pylibs",
  "aarch64 is not x86_64"
);

// 7. N4 — a registered artifact provider means "no local bundle": the Android
// host (nodejs-mobile reports process.platform === "linux" and the phone CPU
// is aarch64) would otherwise pick "bundle" against a linux-aarch64 remote —
// a same-platform match! — and die in the provider's hard reject. With the
// provider in place every remote with a python3 goes through pylibs; without
// one (desktop) nothing changes. setArtifactProvider mutates module state, so
// it MUST be undone before the suite ends.
const androidish = {
  ensureBundle: async () => {
    throw new Error("no backend bundle on Android: the backend runs on the SSH remote");
  },
  ensurePyLibsTar: async () => {
    throw new Error("no download in this unit test");
  },
};
try {
  setArtifactProvider(androidish);
  check(hasLocalBundle() === false, "provider registered -> hasLocalBundle() is false");
  check(
  chooseStrategy(probe("Linux", "aarch64", "3.12"), "linux-aarch64") === "pylibs",
  "phone (linux-aarch64) -> linux-aarch64 remote picks pylibs, not bundle"
);
  check(
  chooseStrategy(probe("Linux", "x86_64", "3.10"), "linux-x86_64") === "pylibs",
  "phone -> same-platform remote (linux-x86_64) still pylibs, never bundle"
);
  check(
  chooseStrategy(probe("Linux", "x86_64"), "linux-x86_64") === null,
  "no remote python3 -> null even with a provider"
);
  let rejected = false;
  try {
    setArtifactProvider({ ensureBundle: async () => {} }); // no ensurePyLibsTar
  } catch (e) {
    rejected = true;
  }
  check(rejected, "setArtifactProvider requires ensurePyLibsTar");
} finally {
  setArtifactProvider(null);
}
check(hasLocalBundle() === true, "provider removed -> hasLocalBundle() true again");
check(
  chooseStrategy(probe("Linux", "x86_64", "3.10"), "linux-x86_64") === "bundle",
  "provider removed -> same-platform remote picks bundle again"
);

// 8. resolveBash: the bash spawn used for both builds must be a working bash
// (on Windows specifically NOT WSL's System32\bash.exe, which sees another fs)
const bash = resolveBash();
if (process.platform === "win32") {
  check(
  bash === "bash" || fs.existsSync(bash),
  "resolved bash is a real file"
);
  check(
  bash === "bash" || !path.resolve(bash).toLowerCase().startsWith(
      path.resolve(process.env.SystemRoot || "C:\\Windows", "System32").toLowerCase() + path.sep
    ),
  "resolved bash is not WSL's System32 bash"
);
} else {
  check(bash === "bash", "non-windows resolveBash is plain bash");
}

console.log("client platformTag:", platformTag(), "| resolved bash:", bash);
summary("remote-strategy");
