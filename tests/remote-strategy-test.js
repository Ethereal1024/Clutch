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
const { resolveBash, platformTag } = require("../ui/server-bundle");
const { check, summary } = require("./harness");

const probe = (os, arch, python) => ({ os, arch, python: python || "" });

// 1. THE regression: Windows client -> Linux x86_64 remote (the reported case)
check(
  "win->linux x86_64 (py3) picks pylibs, not bundle",
  chooseStrategy(probe("Linux", "x86_64", "3.10"), "windows-x86_64") === "pylibs"
);

// 2. arch matches but OS differs: pylibs (this also used to pick bundle)
check(
  "mac arm64 -> linux arm64 (py3) picks pylibs",
  chooseStrategy(probe("Linux", "arm64", "3.12"), "darwin-arm64") === "pylibs"
);

// 3. same platform: bundle is back in business
check(
  "linux x86_64 -> linux x86_64 picks bundle",
  chooseStrategy(probe("Linux", "x86_64", "3.10"), "linux-x86_64") === "bundle"
);
check(
  "mac arm64 -> darwin arm64 picks bundle (even without remote python)",
  chooseStrategy(probe("Darwin", "arm64"), "darwin-arm64") === "bundle"
);
check(
  "win x86_64 -> windows x86_64 picks bundle",
  chooseStrategy(probe("Windows", "x86_64", "3.11"), "windows-x86_64") === "bundle"
);

// 4. uname -s capitalization must not matter
check(
  "os comparison is case-insensitive",
  chooseStrategy(probe("LINUX", "x86_64", "3.10"), "linux-x86_64") === "bundle" &&
    chooseStrategy(probe("linux", "aarch64", "3.10"), "linux-x86_64") === "pylibs"
);

// 5. no remote python3 and no same-platform bundle -> null (SSH-tools fallback)
check(
  "linux arm64 without python3 from a win client -> null",
  chooseStrategy(probe("Linux", "arm64"), "windows-x86_64") === null
);
check(
  "missing os field with python -> pylibs",
  chooseStrategy(probe("", "x86_64", "3.8"), "linux-x86_64") === "pylibs"
);
check(
  "missing os field without python -> null",
  chooseStrategy(probe("", "x86_64"), "linux-x86_64") === null
);

// 6. aarch64 vs x86_64 naming from uname -m
check(
  "aarch64 is not x86_64",
  chooseStrategy(probe("Linux", "aarch64", "3.10"), "linux-x86_64") === "pylibs"
);

// 7. resolveBash: the bash spawn used for both builds must be a working bash
// (on Windows specifically NOT WSL's System32\bash.exe, which sees another fs)
const bash = resolveBash();
if (process.platform === "win32") {
  check(
    "resolved bash is a real file",
    bash === "bash" || fs.existsSync(bash)
  );
  check(
    "resolved bash is not WSL's System32 bash",
    bash === "bash" || !path.resolve(bash).toLowerCase().startsWith(
      path.resolve(process.env.SystemRoot || "C:\\Windows", "System32").toLowerCase() + path.sep
    )
  );
} else {
  check("non-windows resolveBash is plain bash", bash === "bash");
}

console.log("client platformTag:", platformTag(), "| resolved bash:", bash);
summary();
