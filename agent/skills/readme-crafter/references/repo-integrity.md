# Repo Integrity Patterns

Use this reference when the repository is a library, SDK, framework, hybrid
framework/playground repo, or any project where README drift can easily create
false promises.

This file exists to help the agent answer one question correctly:

**Does the README match how the repository is actually meant to be consumed?**

## 1. Distribution posture

Determine which of these is true **before** writing install instructions:

### Published package

Use this only when publication is proven by one or more of:

- registry badge or link
- release or package page in repo docs
- clearly documented package install command already grounded in the repo context
- user confirmation

What to do:

- put registry install near the top
- include version or package status if it is real
- keep source build instructions secondary unless contributors need them

### Source-first repository

Use this when the safest path is:

```text
clone -> install -> configure -> run/build
```

What to do:

- lead with local setup
- avoid speculative package install commands
- treat the repo itself as the product entry point

### Framework + playground hybrid

Use this when the repo contains both:

- a reusable core or package entry such as `src/index.ts`
- a runnable local app/demo/playground such as `src/main.tsx`, `index.html`, or
  a `dev` script

What to do:

- separate **Run locally** from **Consume the library**
- explain the relationship between the reusable core and the demo app
- do not mix repo-local import paths into consumer-facing examples

## 2. Public surface checks

For libraries, SDKs, and frameworks, README examples must reflect the public
surface, not the repo internals.

Validate:

- package entry fields (`main`, `module`, `types`, `exports`)
- root export files such as `src/index.ts`
- whether README examples import only exported symbols

Common failure patterns:

- `import ... from '@kernel/core'` in a consumer example
- importing from `src/...` paths in the main README
- showing functions or plugins that exist in the repo but are not exported from
  the package root

## 3. Config parity checks

When the repo includes `.env.example`, `.env.template`, or similar files:

- README env var names must match
- documented default URLs/endpoints must match
- required order of setup must match

Common failure patterns:

- README uses official vendor endpoints while the repo ships custom defaults
- README mentions env vars missing from the example file
- README omits a required setup file that the repo clearly depends on

## 4. Link and asset checks

README links should be treated as part of the product surface.

Verify:

- local markdown links
- screenshots and diagrams
- docs paths
- `LICENSE`, `CONTRIBUTING.md`, and similar trust anchors

Common failure patterns:

- architecture image path no longer exists
- screenshot moved during refactor
- README links to a docs folder that is gone

## 5. Hybrid repo writing pattern

For hybrid framework/playground repos, a good README shape is:

```text
Name + one-liner
Why this exists
Quick start from source
Scripts / local run path
Architecture
Public library surface
Repo layout
Missing trust assets or known limits
```

What to avoid:

- pretending the repo is already a polished published package if that is not proven
- using playground-only internals as if they were package APIs
- hiding the local run path behind architecture prose

## 6. Hard-compare matrix

Before finalizing a README for a technical repo, compare:

- README vs package/build metadata
- README vs root public exports
- README vs `.env.example` / sample config
- README vs referenced local assets and docs

If any of those disagree, fix the README or explicitly mark the area as needing
verification.
