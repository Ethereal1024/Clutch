# Worked Examples

Use this file when the right README direction is still ambiguous after reading
`SKILL.md` and `style-guide.md`.

These are not rigid templates. Copy the **decision logic**:

- What is the repo?
- How is it meant to be consumed?
- Who is the README really for?
- What proof is actually available?

## Example 1: Developer Utility (Published CLI)

### Input snapshot

- Project type: TypeScript CLI package
- Distribution posture: published package
- Primary audience: developers evaluating adoption
- Secondary audience: contributors
- Maturity: active development, releases and CI already exist
- Real proof assets: package registry page, CI badge, benchmark output, examples
- Best temperament: Developer Utility

### Section plan

```text
Name + trust badges -> one-liner -> install -> quick example with output ->
highlights -> docs link -> contributing -> license
```

### Drafted opening

```markdown
# lockpeek

[![CI](https://img.shields.io/github/actions/workflow/status/acme/lockpeek/ci.yml?style=flat-square)](https://github.com/acme/lockpeek/actions)
[![npm version](https://img.shields.io/npm/v/lockpeek?style=flat-square)](https://www.npmjs.com/package/lockpeek)
[![License](https://img.shields.io/github/license/acme/lockpeek?style=flat-square)](./LICENSE)

Inspect `package-lock.json`, `pnpm-lock.yaml`, and `yarn.lock` files in one CLI
without opening three different tools.

## Install

```bash
npm install -g lockpeek
```

## Quick example

```bash
lockpeek diff ./old-lock ./new-lock
# => 12 packages added
# => 3 packages upgraded
# => 1 package removed
```
```

### Why this works

- Install is safe because publication is real and verifiable
- Output proves value faster than adjectives
- No architecture section is included because evaluators do not need it first

## Example 2: Academic Authority

### Input snapshot

- Project type: research repo accompanying a paper
- Distribution posture: source-first research release
- Primary audience: researchers and ML engineers
- Secondary audience: practitioners reproducing results
- Maturity: published paper, benchmark tables, Docker support
- Real proof assets: arXiv link, BibTeX, benchmark table, diagram, demo GIF
- Best temperament: Academic Authority

### Section plan

```text
Logo/title -> paper badges -> short value statement -> demo ->
news/update timeline -> benchmark table -> installation -> usage ->
citation -> related projects
```

### Drafted opening

```markdown
<div align="center">
  <h1>GraphRAG-Lite</h1>
  <p>Lightweight graph-enhanced retrieval for long-context question answering.</p>
</div>

[![arXiv](https://img.shields.io/badge/arXiv-2502.01234-b31b1b?style=for-the-badge)](https://arxiv.org/abs/2502.01234)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)](./pyproject.toml)
[![License](https://img.shields.io/badge/License-MIT-111827?style=for-the-badge)](./LICENSE)

GraphRAG-Lite improves multi-hop retrieval quality on long documents while
keeping the serving stack simple enough to reproduce locally.

## Benchmarks

| Model | HotpotQA EM | 2Wiki F1 | Avg Latency |
|---|---:|---:|---:|
| Dense baseline | 61.2 | 68.4 | 210 ms |
| GraphRAG-Lite | **67.9** | **74.1** | 248 ms |
```

### Why this works

- Academic trust anchors appear immediately
- Practical value still appears near the top
- Benchmarks are evidence, not decoration

## Example 3: Product (Store-Listed Extension)

### Input snapshot

- Project type: browser extension
- Distribution posture: public store distribution
- Primary audience: end users evaluating install
- Secondary audience: contributors
- Maturity: stable public release
- Real proof assets: store links, screenshots, supported browsers, verified rating
- Best temperament: Product

### Section plan

```text
Hero image -> tagline -> one-liner -> compatibility -> store buttons ->
social proof -> feature highlights -> screenshot -> FAQ/support -> community
```

### Drafted opening

```markdown
<p align="center">
  <img src="./.github/hero.png" alt="TabFlow hero" width="100%" />
</p>

# TabFlow

Save, group, and reopen research tabs without turning your browser into chaos.

[![Chrome Web Store](https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/tabflow/...)
[![Firefox Add-ons](https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/tabflow/)

Works in Chrome, Edge, and Firefox. Rated 4.8/5 by verified public store listings.
```

### Why this works

- Installation is the main CTA, so store buttons appear early
- Compatibility and proof reduce hesitation
- Ratings are only included because they are externally verifiable

## Example 4: Source-First Framework With Playground

This is the pattern that many README generators mishandle.

### Input snapshot

- Project type: React framework / plugin-based frontend system
- Distribution posture: source-first framework with local playground and library build
- Primary audience: evaluators deciding whether to adopt the architecture
- Secondary audience: developers trying to run the repo locally
- Maturity: active development, no clear registry proof, no release badges
- Real proof assets: source tree, package metadata, `build:lib` script,
  `src/index.ts`, `src/main.tsx`, `index.html`, `.env.example`
- Missing proof assets: package registry listing, screenshot, CI badge, release tags
- Best temperament: Developer Utility

### Decision rules

- Do **not** lead with `npm install <package>` unless publication is proven
- Separate **Run the repo locally** from **Consume the library**
- Use public root exports in code examples, not repo-internal aliases
- If a playground exists, describe it explicitly instead of pretending the repo
  is only a package

### Section plan

```text
Name + one-liner -> why this exists -> quick start from source ->
scripts table -> architecture -> public plugin surface ->
repo layout -> known missing trust assets
```

### Drafted opening

```markdown
# zenmux-chat

Plugin-based React chat kernel for building multi-model chat UIs with slot-based
UI composition, request lifecycle hooks, and source-first extensibility.

`zenmux-chat` currently combines two things in one repository:

- a reusable kernel and plugin surface
- a local playground app for evaluating the stack end to end

## Quick start

```bash
git clone https://github.com/acme/zenmux-chat.git
cd zenmux-chat
npm install
cp .env.example .env
npm run dev
```

## Library entry

The library build uses `src/index.ts` as the root public entry.
If you add consumer-facing examples, import from the package root or documented
public paths only.
```

### Why this works

- It does not invent package publication
- It reflects the repo's hybrid posture honestly
- It gives evaluators and first-time runners both what they need

## Mini Pattern: Surgical Improvement

### Input snapshot

- Existing README has a long intro
- Install is buried below the fold
- Badge styles are mixed
- One code example references an old API name
- The repo already has good deeper docs

### Recommended output behavior

1. Diagnose the current README against the checklist
2. Produce a short prioritized fix list
3. Preserve tone and structure where possible
4. Move install and first example upward
5. Correct stale API and import examples
6. Remove low-value or unverified badges
7. Link deeper docs instead of duplicating them

### Example diagnosis

```text
Top issues:
1. The first screen does not explain the project before scrolling
2. Installation is buried after long prose
3. The example uses an import path that is not part of the public package surface
4. A linked architecture image does not exist in the repository
```

### Why this works

- It improves the README without forcing a rewrite
- It respects the user's voice
- It fixes the highest-friction issues first

## Usage Notes

- Choose the example whose **project type + distribution posture + audience + proof assets**
  most closely match the repo in front of you
- If the repo has both a runnable app and a library build, document both paths
  separately
- If publication is not proven, document source-first usage instead of inventing
  registry installation
- If proof assets are missing, omit the section or turn it into a recommendation
