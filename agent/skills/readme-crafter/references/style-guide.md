# Style Guide — README Temperaments

This reference provides detailed guidance for each project temperament. Load this
file when you need specific examples, badge strategies, or section layouts for a
particular style.

## 1. Developer Utility

**When to use:** Libraries, SDKs, CLI tools, packages published to registries
(npm, PyPI, crates.io), developer infrastructure, and source-first frameworks
that are mainly evaluated by developers.

**Real-world references:** Pydantic, uv (astral-sh/uv), Ollama, OpenAI Python SDK

**Core principles:**
- Developers evaluate libraries in under 30 seconds
- Code examples are the primary persuasion tool
- Installation must reflect the repo's real consumption mode
- Link to full docs — README is the gateway, not the encyclopedia

**Typical structure:**
```
[Project name (possibly with logo)]
[Badge row — CI, version, downloads, license]
[One-liner description — problem-focused]
[Install — single command]
[Quick example — minimal code showing input→output]
[Features — 3-5 with code snippets]
[Documentation link]
[Contributing — brief, link to CONTRIBUTING.md]
[License]
```

**Badge strategy:** `flat` or `flat-square` style. Focus on trust signals:

```markdown
[![CI](https://img.shields.io/github/actions/workflow/status/org/repo/ci.yml?style=flat-square)](link)
[![PyPI](https://img.shields.io/pypi/v/package?style=flat-square)](link)
[![Downloads](https://img.shields.io/pypi/dm/package?style=flat-square)](link)
[![License](https://img.shields.io/github/license/org/repo?style=flat-square)](link)
```

**Code example pattern (show input and output):**
```python
from mylib import analyze

result = analyze("The product is excellent and fast delivery")
print(result)
# => Sentiment(label='positive', score=0.94, aspects=['product', 'delivery'])
```

**The "uv pattern" — prove performance with real output:**
```markdown
## Performance
\`\`\`
$ time mylib process data.csv
Processed 1,247,893 rows
Time: 0.34s (3.6M rows/sec)
\`\`\`
```

**Tone:** Technical, precise, efficient. No marketing fluff. Let the code speak.
Respect the reader's time above all.

### Source-first framework / playground variant

Some repositories in this temperament are **not** cleanly "published package"
projects. They may contain:

- a library entry such as `src/index.ts`
- a local playground app such as `src/main.tsx` or `index.html`
- a library build script such as `build:lib`
- no trustworthy proof of package publication

For these repos:

- Lead with what the framework or kernel does
- Put "run locally from source" before any speculative package install command
- Separate **Run the repo** from **Consume the library**
- Validate that example imports use the public root entry, not repo-internal aliases
- Avoid package registry badges unless the publication is real and verifiable

**What to avoid:**
- Long introductory paragraphs before the install command
- Pseudocode or simplified examples that don't actually run
- Documenting the entire API in README (link to docs)
- Claiming performance without showing numbers

---

## 2. Product

**When to use:** End-user focused apps, startup/indie products, mobile or desktop
tools, browser extensions, consumer-facing products, tools listed on stores
(Chrome Web Store, App Store, etc.), developer productivity products.

**Real-world references:** Happy Coder (slopus/happy), Raycast, Linear, Gemini
Voyager (Nagi-ovo/gemini-voyager)

**Core principles:**
- README should feel like a product page, not a technical document
- Prioritize visual impact and speed-to-install
- Less is more — every word must earn its place
- Social proof matters when it exists and is verifiable

**Typical structure:**
```
[Centered Logo — 300-400px wide]
[H1 Title — what it is in one phrase]
[Subtitle — the key value prop in one sentence]
[Navigation links — key entry points separated by bullets]
[Hero image or promo banner — full-width product screenshot]
[Install path — store buttons for store-listed, numbered steps for self-hosted]
[How it works — 1-2 paragraphs max]
[Features — organized by user value, not implementation]
[Social proof — if verifiable (store ratings, awards, testimonials)]
[Support / Community links]
[Contributing — brief, dev setup in <details> if needed]
[License — one line]
```

**Badge strategy:** Keep badges minimal so the product image speaks louder.

- For self-hosted or source-first products: 2-3 badges maximum (version, license)
- For store-listed products: use `for-the-badge` for install CTAs, `flat-square`
  for info

```markdown
<!-- Store install buttons -->
[![Chrome](https://img.shields.io/badge/Chrome_Web_Store-Install-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](link)
[![Firefox](https://img.shields.io/badge/Firefox_Add--ons-Install-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white)](link)
```

**Social proof — only when verifiable:**

| Layer | Method |
|---|---|
| Data | Stars, downloads, store ratings badges |
| Authority | Product Hunt featured, Trendshift badge |
| User voice | KOL tweet screenshots, testimonials (user-provided only) |
| Growth | Star History chart at bottom |

**Visual approach:**
- Centered HTML layout for top section (`<div align="center">`)
- High-quality hero image or product screenshot
- Optional mascot/character for brand personality
- Use `---` dividers between major sections to create visual "cards"
- No technical diagrams unless the architecture IS the product

**Tone:** Friendly, direct, confident. Short sentences. Conversational but not
overly casual. First person plural is acceptable ("We built this because...").

**What to avoid:**
- Walls of text
- Extensive configuration docs (link to external docs instead)
- Badge clutter
- Technical jargon in the first screen
- Missing store links or broken install paths for store-listed products
- Generic feature descriptions without demonstrating value

**Example opening:**
```markdown
<div align="center">
  <img src=".github/logo.png" width="400" />
  <h1>Project Name</h1>
  <h4>One-sentence value proposition that makes you want to try it.</h4>
  <a href="...">Docs</a> · <a href="...">Demo</a> · <a href="...">Discord</a>
</div>

<div align="center">
  <img src=".github/hero.png" width="100%" />
</div>
```

---

## 3. Academic Authority

**When to use:** Research projects with associated papers, ML/AI model releases,
academic lab outputs, projects published at conferences (NeurIPS, ICML, EMNLP, etc.)

**Real-world references:** HKUDS/LightRAG, HKUDS/DeepCode, HKUDS/RAG-Anything

**Core principles:**
- Dual-track serving: academic credentials for researchers, practical docs for
  developers
- The paper is a trust anchor — surface it prominently
- Benchmarks are your proof — show comparisons, not claims
- Consistent visual branding across related projects

**Typical structure:**
```
[Centered Logo — with CSS shadow/rounded corners for polish]
[H1 Title with emoji — "🚀 ProjectName: Tagline"]
[Trendshift badge (if eligible)]
[Badge matrix — for-the-badge style, unified dark color scheme]
[Language switch links — English | 中文]
[GIF demo or framework diagram]
[📢 News — reverse chronological, old items in <details>]
[Architecture diagram]
[📊 Benchmarks — comparison tables with competitors]
[Installation — multiple methods]
[Usage — code examples]
[📖 Citation — BibTeX block]
[🔗 Related Projects — ecosystem cross-links]
[⭐ Star History]
[🤝 Contributors wall]
```

**Badge strategy:** Use `for-the-badge` style with unified color scheme for
professional, branded feel. Recommended badge set:

```markdown
<!-- Unified color scheme example (HKUDS style) -->
![arXiv](https://img.shields.io/badge/📄_arXiv-2410.05779-ff6b6b?style=for-the-badge&labelColor=1a1a2e)
![Stars](https://img.shields.io/github/stars/org/repo?style=for-the-badge&labelColor=1a1a2e&color=00d9ff)
![Python](https://img.shields.io/badge/🐍_Python_3.9+-4ecdc4?style=for-the-badge&labelColor=1a1a2e)
![License](https://img.shields.io/badge/📜_MIT-45b7d1?style=for-the-badge&labelColor=1a1a2e)
![Discord](https://img.shields.io/badge/💬_Discord-7289da?style=for-the-badge&labelColor=1a1a2e)
```

**Benchmark presentation:**
- Use win-rate percentages (more intuitive than raw scores)
- Always name competitors explicitly
- Provide reproduction steps (in collapsible `<details>`)
- Include the benchmark dataset name and size

**News section pattern:**
```markdown
## 📢 News
- [2025.07] 🎯 Paper accepted at EMNLP 2025!
- [2025.06] ✨ v2.0 released with Docker support
- [2025.05] 🚀 Reached 10k GitHub stars

<details>
<summary>📰 Older news</summary>

- [2025.03] Initial release
- [2025.02] arXiv preprint published
</details>
```

**Citation block:**
```markdown
## 📖 Citation
If you find this work useful, please cite our paper:
\`\`\`bibtex
@inproceedings{author2025project,
  title={Paper Title},
  author={Author, First and Author, Second},
  booktitle={Conference Name},
  year={2025}
}
\`\`\`
```

**Tone:** Technically precise, confident but not boastful. Mix academic rigor with
developer accessibility. Use emoji for section headers to soften the academic feel.

**What to avoid:**
- Putting the entire paper abstract in the README
- Omitting practical installation/usage (researchers still need to run the code)
- Stale news sections that show inactivity
- Inconsistent badge styling that looks unprofessional

---

## 4. Community Narrative

**When to use:** Projects with large contributor communities, multi-agent systems,
complex tools with active developer communities, projects that tell a story.

**Real-world references:** BettaFish (666ghj/BettaFish), Langchain

**Core principles:**
- The README should make readers feel excited to join
- Brand storytelling creates emotional connection
- Detailed documentation reduces barrier to entry
- Dual-path installation (Docker quick + source detailed)

**Typical structure:**
```
[Logo — large, branded]
[Trendshift badge]
[Badge row — flat-square, covering key metrics]
[Language switch]
[⚡ Project Overview — problem + solution + brand story]
[Six/key advantages — numbered list with bold titles]
[Vision statement — aspirational closing line]
[🏗️ Architecture — diagram + flow table]
[🚀 Quick Start (Docker)]
[🔧 Source Installation — detailed, step-by-step]
[⚙️ Configuration — grouped by concern]
[🤝 Contributing]
[🦖 Roadmap — what's next]
[⚠️ Disclaimer (if needed for legal/ethical reasons)]
[🎉 Community channels — QQ/WeChat/Discord with QR codes]
[👥 Contributors wall]
[📈 Star History + Repo Stats]
```

**Badge strategy:** `flat-square` style for a clean, consistent look. Cover:
Stars, Forks, Issues, PRs, License, Version, Docker.

**Brand storytelling pattern:**
```markdown
## ⚡ Project Overview

"ProjectName" is a [what it is] that [core value proposition].

> The name "ProjectName" comes from [origin story]. It symbolizes [meaning].

### Key Advantages

1. **Advantage One** — Detailed explanation of why this matters
2. **Advantage Two** — Detailed explanation
3. **Advantage Three** — Detailed explanation

> Vision statement: "Started from X, but not limited to X."
```

**Dual-path installation:**
```markdown
## 🚀 Quick Start (Docker)
The fastest way to get running. Two commands:
\`\`\`bash
cp .env.example .env
docker compose up -d
\`\`\`

## 🔧 Install from Source
For full control and development.
### Prerequisites
- Python >= 3.10
- PostgreSQL 15+
### Step 1: Create environment
...
```

**Tone:** Enthusiastic, warm, inclusive. Uses emoji headers freely. Can be more
verbose than other styles. Exclamation marks are acceptable in moderation.

**What to avoid:**
- README exceeding ~1000 lines (move deep config docs to docs/)
- Sponsor placement above project description
- Outdated version badges
- Code structure trees longer than 30 lines (use `<details>` to collapse)

---

## Cross-cutting Guidelines

### Mermaid diagrams

GitHub renders Mermaid natively in ` ```mermaid ` code blocks. Use these diagram
types based on what you need to communicate:

| Diagram Type | Best For |
|---|---|
| Flowchart | Architecture overviews, data flows, decision trees |
| Sequence | API interactions, request lifecycles, multi-service flows |
| Class / ER | Data models, type hierarchies, database schemas |
| State | State machines, lifecycle stages |
| Mindmap | Feature overviews, concept relationships |
| Gantt | Roadmaps, timelines (use sparingly in README) |

Keep Mermaid diagrams simple in README. If a diagram needs more than 15-20 nodes,
consider splitting it or recommending a polished exported image instead.

### GitHub Alerts

Use these callout blocks for important information:

```markdown
> [!NOTE]
> Supplementary context the reader should know.

> [!TIP]
> Helpful suggestion that improves the experience.

> [!IMPORTANT]
> Critical information for successful setup or usage.

> [!WARNING]
> Potential pitfalls or common mistakes.

> [!CAUTION]
> Actions that could cause data loss or irreversible changes.
```

Use alerts sparingly. One or two per README section is usually the right density.
More than that dilutes their impact.

### Badges

**shields.io URL anatomy:**
```
https://img.shields.io/badge/<LABEL>-<MESSAGE>-<COLOR>?style=<STYLE>&logo=<LOGO>&logoColor=<LOGO_COLOR>&labelColor=<LABEL_COLOR>
```

**Style selection by temperament:**

| Temperament | Recommended Style | Reasoning |
|---|---|---|
| Developer Utility | `flat` or `flat-square` | Clean, professional, unobtrusive |
| Product | Minimal badges or `for-the-badge` for CTAs | Let product visuals speak |
| Academic Authority | `for-the-badge` with unified `labelColor` | Branded, authoritative look |
| Community Narrative | `flat-square` | Consistent, metrics-oriented |

**Useful dynamic badges:**
- CI status: `img.shields.io/github/actions/workflow/status/<user>/<repo>/<file>`
- Package version: `img.shields.io/pypi/v/<pkg>` or `img.shields.io/npm/v/<pkg>`
- Downloads: `img.shields.io/pypi/dm/<pkg>` or `img.shields.io/npm/dm/<pkg>`
- License: `img.shields.io/github/license/<user>/<repo>`
- Stars: `img.shields.io/github/stars/<user>/<repo>`

**Rules:**
- One consistent style per README
- 3-8 badges is the practical range; more causes visual noise
- Only include badges that carry real, meaningful information
- Match badge colors to project branding when possible

### HTML layout patterns

GitHub allows a subset of HTML that enables richer visual structure:

**Centered header:**
```html
<div align="center">
  <img src="logo.png" width="200" />
  <h1>Project Name</h1>
  <p>One-line description.</p>
</div>
```

**Dark/light mode image switching:**
```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="logo-light.svg">
  <img src="logo-light.svg" alt="Logo" width="200">
</picture>
```

**Collapsible sections:**
```html
<details>
<summary>Click to expand: Advanced configuration</summary>

Content here (must have blank line after summary tag).

</details>
```

### Image sizing
- Logos: 120-400px wide, centered
- Hero screenshots: full width or max 800px
- Architecture diagrams: 600-800px wide
- Badges: let shields.io handle sizing (standard or for-the-badge)

### Color consistency
Pick a color palette and stick with it across all badges and visual elements. If
the project has brand colors, use those. If not, common professional palettes:

- **Dark tech**: `labelColor=1a1a2e` with accents `00d9ff`, `ff6b6b`, `4ecdc4`
- **Clean light**: Default shields.io colors (works for most Developer Utility)
- **Brand-matched**: Extract 2-3 colors from the project logo

### Multilingual README
- Primary language as `README.md`
- Secondary as `README-XX.md` (e.g., `README-ZH.md`, `README-EN.md`)
- Language switch badges or links near the top of each version
- Both versions should have identical structure — do not omit sections

### AI-ready supporting files
- If the repo ships `AGENTS.md`, `CLAUDE.md`, `llms.txt`, or similar
  machine-readable files, mention them only when the project is actually
  agent-facing or automation is a meaningful use case
- Keep AI-oriented links below the main install and usage path for human readers
- Do not add an "AI" section just because those files exist
