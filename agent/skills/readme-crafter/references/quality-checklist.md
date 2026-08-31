# Quality Checklist — README Verification

Run this checklist after generating or improving a README.

The goal is not "make it look polished." The goal is "make it true, usable, and
well-shaped for this repository."

## Core Checks (Must Pass)

### 1. 3-Second Test
**Question:** Can a stranger understand what the project is from the first
screen without scrolling?

**Pass criteria:**
- Project name is visible
- A one-liner explains what the project does in plain language
- The one-liner leads with the problem solved or value delivered

**Common failures:**
- Opening with badges and no explanation
- First sentence is architecture jargon instead of user value
- The reader still cannot tell whether this is a library, app, CLI, or framework

### 2. Copy-Paste Test
**Question:** Can the installation and setup commands be copied and executed as
written?

**Pass criteria:**
- Commands match actual scripts, build tools, and package managers in the repo
- Package names, binary names, and file paths are real
- Required setup order is correct
- Placeholder values are clearly explained

**How to verify:**
- Compare `npm run`, `pnpm`, `pip`, `cargo`, `go`, Docker, or Make commands
  against the repo config
- Compare install commands against actual package metadata

**Common failures:**
- Wrong package manager
- Wrong package name
- Missing prerequisite or env setup
- Commands copied from an older README version

### 3. Solo Test
**Question:** Can a new reader get from zero to first success using only the
README?

**Pass criteria:**
- Prerequisites are stated when they matter
- Installation is complete enough to run
- At least one usage path reaches a visible result
- The README does not assume hidden tribal knowledge

**Common failures:**
- "Configure your API key" with no file location or variable name
- Example code before install/setup
- Missing service, database, or model provider setup

### 4. Scan Test
**Question:** If you read only the headings and code blocks, do you still
understand most of the project?

**Pass criteria:**
- Headings follow a meaningful flow: what -> install -> use -> more
- Code blocks are self-explanatory or lightly annotated
- Important facts are surfaced in headings, tables, or code, not buried in prose

**Common failures:**
- Generic headings like `Overview` and `Usage` without substance
- Long prose blocks hiding the only important information
- Code blocks with no clue why they matter

### 5. Accuracy Test
**Question:** Do the examples match the current project behavior?

**Pass criteria:**
- Function names, method names, and CLI commands exist
- Parameter names and flags are current
- Output examples do not contradict the real behavior

**Common failures:**
- Stale examples from older APIs
- Invented helper functions
- Commands that no longer exist

### 6. Public Surface Integrity Test
**Question:** If this repo is a library, SDK, or framework, do README examples
use the public surface instead of repo-internal paths?

**Pass criteria:**
- Import paths point to the documented package entry or supported public paths
- Example symbols are exported from the root public surface when the README
  claims that usage mode
- Internal aliases are only used in contributor docs, not end-user examples

**How to verify:**
- Compare README imports against `package.json` entry fields and root export files
- Check whether referenced symbols are actually exported

**Common failures:**
- Importing from repo-internal aliases like `@kernel/...`
- README examples using symbols that are not exported from the package entry
- Mixing "library consumer" examples with "repo contributor" examples

### 7. Configuration Parity Test
**Question:** Does the README's setup guidance match the repo's actual config
surface?

**Pass criteria:**
- Env vars mentioned in the README exist in `.env.example`, `.env.template`, or
  equivalent files
- Defaults, endpoints, and sample values are not contradicted
- Required config files are real and correctly named

**Common failures:**
- README documents env vars that do not exist
- `.env.example` and README drift apart
- README implies official vendor endpoints while the repo ships custom defaults

### 8. Distribution Posture Test
**Question:** Does the README accurately represent how this project is meant to
be consumed?

**Pass criteria:**
- Published package claims are backed by real proof
- Source-first repos are documented as source-first
- Hybrid repos clearly separate "run the playground/app" from "consume the library"
- The README does not imply registry publication just because a package name exists

**Common failures:**
- `npm install package-name` appears with no publication proof
- Playground app and library build are merged into one confusing flow
- The repo is treated like a product app when it is really a framework or SDK

### 9. Freshness Test
**Question:** Does the README reflect the current state of the repository?

**Pass criteria:**
- Version or release information is current
- Features described exist in the repo
- Deprecated or planned items are clearly labeled
- README sections still match the present repo structure

**Common failures:**
- Old screenshots
- Roadmap items described as shipped
- Outdated architecture, plugin count, or command list

## Structural Checks (Should Pass)

### 10. Link And Asset Integrity Test
**Question:** Do all referenced local docs, files, screenshots, and diagrams exist?

**Pass criteria:**
- Internal markdown links resolve
- Linked docs files and directories exist
- Referenced screenshots, diagrams, and logos exist at those paths
- License and contributing links point to real files

**Common failures:**
- Referencing `docs/architecture.png` when the file does not exist
- Linking to `CONTRIBUTING.md` or `LICENSE` that is not present
- Broken image paths after repo restructuring

### 11. Completeness By Type
**Question:** Does the README include the sections that matter for this kind of project?

**Minimum sections for any project:**
- [ ] Project name + one-line description
- [ ] Installation or setup path
- [ ] Basic usage or run path
- [ ] License or license status

**Additional expectations by type:**

For **libraries / SDKs / frameworks:**
- [ ] Public usage example
- [ ] Public import path or consumption mode
- [ ] Pointer to deeper API or architecture docs

For **CLI tools:**
- [ ] Command example with output
- [ ] Command or flag summary, or link to `--help`

For **web applications / playgrounds:**
- [ ] Screenshot, GIF, or explicit note that visual assets are still missing
- [ ] Run locally path or demo link

For **research repos:**
- [ ] Paper or arXiv link
- [ ] Citation block
- [ ] Benchmark or evaluation context

For **hybrid repos (framework + playground / library + demo):**
- [ ] Clear split between "run the repo" and "consume the package"

### 12. Tone Consistency Test
**Question:** Is the writing style consistent from top to bottom?

**Pass criteria:**
- Voice stays consistent
- Formality level is stable
- Emoji use is intentional and consistent
- Badge style is consistent if badges are used at all

**Common failures:**
- Intro sounds like product marketing, setup sounds like internal notes
- Random emoji bursts
- Mixed badge styles

### 13. Evidence Integrity Test
**Question:** Are external proof signals real, verifiable, and appropriate?

**Pass criteria:**
- Stars, downloads, ratings, registry badges, and store badges point to real
  sources or dynamic endpoints
- Awards, paper links, venue claims, testimonials, and logos are user-provided
  or externally verified
- Benchmark claims include enough context to avoid misleading readers

**Common failures:**
- Fabricated download counts
- Invented conference badges
- Testimonials or partner logos that were never provided
- Benchmark wins with no visible source or methodology

## Reporting Format

After running the checklist, report in this format:

```text
README Quality Check Results:

Passed:
  ✓ 3-Second Test — clear one-liner explains the project
  ✓ Copy-Paste Test — setup commands verified against package metadata
  ✓ Public Surface Integrity Test — examples use exported package symbols

Issues Found:
  ✗ Configuration Parity Test — README mentions `VITE_FOO_API_KEY` but `.env.example` does not
    → Fixed: aligned the README with the real env file
  ✗ Link And Asset Integrity Test — `docs/architecture.png` is referenced but missing
    → Fixed: replaced it with Mermaid architecture text

Recommendations:
  △ Add a real screenshot or GIF for the local playground
  △ Add release tags or a registry link before documenting registry installation
```

Distinguish between:
- **Issues** you can fix immediately
- **Issues** that require user-provided assets or product decisions
- **Recommendations** that improve trust or polish but are not mandatory

### Suggestions For Further Improvement

After the checklist report, include a short list of concrete ways the user can
further improve the README beyond what the agent generated. Keep it to 3-5 items,
specific to the project.

```text
Suggestions for further improvement:
  → Add a product screenshot (recommended: full-width, placed below the title)
  → Record a terminal demo GIF (try VHS or asciinema for CLI tools)
  → Replace the Mermaid architecture diagram with a polished Excalidraw or
    draw.io export for a more visual feel
  → Add a logo image for the centered header (recommended: 200-400px wide PNG
    or SVG)
  → Set up a CI workflow to enable the CI status badge
```

Focus on assets and actions that would make the biggest visual or trust
difference. Do not suggest changes the agent could have made itself.
