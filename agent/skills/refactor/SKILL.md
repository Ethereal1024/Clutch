---
name: refactor
description: Use this skill whenever the user asks to refactor, simplify, restructure, clean up, or improve the quality of source code. The central mission is fighting complexity — making code easier to read, understand, and maintain for both human developers and Claude Code itself. Trigger for: "refactor this", "clean up the code", "simplify this module", "apply best practices", "improve code quality", "too much duplication here", "this is getting hard to follow", "make this easier to understand", or any request that involves improving the internal structure of existing code without changing its external behavior. Also trigger when the user says the code is messy, tangled, hard to navigate, or when they ask for a "DRY pass", "KISS pass", "SOLID pass", or similar principle-driven review.
---

# Refactoring Skill

## The Prime Directive: Fight Complexity

The **sole purpose** of refactoring is to reduce complexity — to make the code simpler,
clearer, and easier to reason about for the next developer who reads it, and for Claude
Code when it analyzes it.

Every proposed change must pass this question first:

> *Does this actually reduce complexity, or am I adding complexity in the name of
> "good practices"?*

If the answer is the latter, do not propose the change.

Complexity has two forms:
- **Essential complexity** — inherent in the problem itself; unavoidable.
- **Accidental complexity** — introduced by the implementation; always worth fighting.

Refactoring targets accidental complexity exclusively.

---

## Workflow: Research First, Change Only on Approval

**Do not modify any source file during the research phase.**

This skill follows a two-phase workflow:

### Phase 1 — Research and Report

1. **Read the entire codebase.** Understand the code's purpose, domain, existing patterns,
   and constraints before forming any opinion about what to change.

2. **Assess codebase size and complexity.** Look at the number of files, the depth of
   call chains, the presence or absence of tests, and how tightly coupled the modules are.
   Use this to decide whether to recommend Safe Refactoring Mode (see below).

3. **Iterate every principle and every sub-principle listed below.** For each one, ask:
   "Does this apply to this specific code? Will applying it concretely reduce complexity?"
   Read the reference files for Clean Code, SOLID, and Clean Architecture as you go.

4. **Collect all findings** — every place where a principle is violated and fixing it would
   bring a clear, concrete benefit.

5. **Write a recommendations file** named `REFACTORING.md` in the root of the working
   project. Do not touch any source file. The file format is described below.

6. **Tell the user** the report is ready and ask them to review it and indicate which
   recommendations they want implemented.

### Phase 2 — Implement Approved Recommendations

Wait for the user to respond with the recommendations they approve. They may say:
- "implement all of them"
- "implement 1, 3, and 5"
- "implement all DRY recommendations"
- "skip the SOLID ones, do everything else"

**Before making any change, check for the safe-mode marker:**

```
<project-root>/.refactor-safe-mode
```

If this file exists, Safe Refactoring Mode is active — follow `references/safe_refactoring.md`
for every approved recommendation, without asking the user again.

If the file does not exist, use the implementation workflow the user requested (or normal
mode if they did not specify).

- **Normal mode:** make the change incrementally and carefully, preserving behaviour.
- **Safe Refactoring Mode:** follow the step-by-step workflow in `references/safe_refactoring.md`
  — identify scope, write characterization tests, confirm they are green, refactor, confirm
  they are still green.

After all approved changes are done, delete `REFACTORING.md` (it has served its purpose).
Do **not** delete `.refactor-safe-mode` — it is a persistent project setting.

---

## Safe Refactoring Mode

See `references/safe_refactoring.md` for the full workflow.

**What it is:** A disciplined implementation workflow that protects against accidental
behavioural regressions. Before touching any code, it writes *characterization tests* —
tests that pin down what the code currently does, not what it should do. The refactoring
then happens inside that safety net. If any characterization test turns red, the refactoring
changed behaviour and must be corrected before proceeding.

The idea comes from *Working Effectively with Legacy Code* by Michael Feathers.

**When to recommend it:** After completing Phase 1 research, assess the codebase. Recommend
Safe Refactoring Mode in `REFACTORING.md` when several of these are true:

- The codebase is large (many files, deep call graphs, multiple modules).
- Test coverage is absent or sparse — there is no existing safety net.
- The code under consideration is critical path logic that is hard to reason about manually.
- The recommended changes touch many call sites or cross module boundaries.
- The code has not been changed in a long time and its full behaviour is not well understood.

**How to surface it:** Add a clearly visible notice at the top of `REFACTORING.md`,
before the recommendations list:

```markdown
## ⚠ Safe Refactoring Mode Recommended

This codebase is large and has limited test coverage. Before implementing any recommendation,
consider enabling Safe Refactoring Mode. In this mode, Claude will write characterization
tests that pin the current behaviour of the code being changed, refactor within that safety
net, and confirm all tests remain green when done.

To enable it permanently for this project, tell Claude: **"enable safe refactoring mode"**.
Claude will create a `.refactor-safe-mode` marker file in the project root. From that point
on, every refactoring session in this project will automatically use safe mode — no need to
ask again, even in future conversations.

To disable it later: delete `.refactor-safe-mode` or tell Claude **"disable safe refactoring mode"**.
To skip it for this session only: **"implement without safe mode"**.
```

**When the user enables Safe Refactoring Mode:**

1. Create the marker file: write a single line to `<project-root>/.refactor-safe-mode`:
   ```
   Safe Refactoring Mode enabled. Delete this file to disable.
   ```
2. Confirm to the user that safe mode is now active and will be remembered for all future
   sessions in this project.
3. Follow `references/safe_refactoring.md` exactly for every approved recommendation from
   this point on.

**When the user disables Safe Refactoring Mode:**

Delete `<project-root>/.refactor-safe-mode` and confirm to the user.

---

## REFACTORING.md Format

The file must be easy for the user to scan and selectively approve. Use this structure:

```markdown
# Refactoring Recommendations

> Generated by the refactor skill. Review each item and tell Claude which ones to implement.

## Summary
<one paragraph: what the main complexity problems are in this codebase>

---

## Recommendations

### R1 · <Principle> · <file or module>
**Issue:** <what the problem is and why it increases complexity>
**Recommendation:** <what to change and how>
**Benefit:** <what becomes simpler or clearer as a result>

### R2 · <Principle> · <file or module>
...
```

Rules for the recommendations list:
- Number every recommendation (`R1`, `R2`, …) so the user can refer to them by number.
- Label each with the principle it falls under (e.g., `DRY`, `KISS`, `SRP`, `Meaningful Names`).
- Include the file name and, where helpful, the function or line range.
- Keep each recommendation self-contained — the user should be able to read it without
  opening the source file and still understand what is being proposed.
- Sort roughly by impact: highest-value, lowest-risk changes first.
- Do not include a recommendation unless the benefit clearly outweighs the overhead.
  When in doubt, omit it — fewer, confident recommendations are more useful than an
  exhaustive list padded with marginal suggestions.

---

## Principles

### DRY — Don't Repeat Yourself

> Every piece of knowledge should have a single, authoritative representation in the system.

Check for:
- Duplicated logic copied across functions or modules.
- Repeated magic values or constants inlined in multiple places.
- Parallel data structures that model the same concept differently.

**Caveat:** Not all similarity is duplication. Two code paths that look similar but represent
genuinely different concepts must stay separate — merging them creates false coupling and
hides the distinction. Only deduplicate knowledge, not coincidental textual similarity.

---

### KISS — Keep It Simple, Stupid

> The simplest solution that correctly handles all current cases is almost always the best.

Check for:
- Clever, non-obvious code where a direct approach would work.
- Unnecessary abstractions, layers, or indirections.
- Conditional logic that could be flattened.
- Speculative complexity designed for imagined future requirements.

Ask: *"Would a developer unfamiliar with this codebase understand this in 30 seconds?"*
If no, it is a candidate for simplification.

---

### YAGNI — You Ain't Gonna Need It

> Don't implement something until you actually need it.

Check for:
- Dead code — functions, parameters, branches, imports that are never called or reached.
- Overly generic abstractions that have only one concrete use today.
- Extension points, plugin systems, or configuration knobs that serve no current user.
- Feature flags or fallback paths for scenarios that no longer exist.

---

### SOLID

See `references/solid.md` for the full list of principles and sub-principles.

**Short summary:** Five principles for designing classes and modules so that changes stay
local and the system remains easy to reason about as it grows — Single Responsibility,
Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion.

Iterate every SOLID principle and every sub-principle. Report only violations where fixing
them would make a meaningful difference to this codebase at its current scale.

---

### Clean Code

See `references/clean_code.md` for the full list of principles and sub-principles.

**Short summary:** Clean Code principles operate at the smallest units — names, functions,
comments, formatting, classes. They ensure each individual piece of code is readable in
isolation, expresses its intent directly, and carries no hidden surprises.

Iterate every Clean Code principle and every sub-principle. These often yield the
highest-value, lowest-risk recommendations.

---

### Clean Architecture

See `references/clean_architecture.md` for the full list of principles and sub-principles.

**Short summary:** Clean Architecture principles operate at the module and system level —
how responsibilities are divided, how dependencies flow, how components are grouped.
Apply only those that address real, present structural problems at this codebase's scale.

---

## The Anti-Over-Engineering Check

Apply this before including any recommendation in the report:

- Does this change make the code shorter, more direct, or easier to scan?
- Does this change reduce the number of concepts a reader must hold in their head at once?
- Is the benefit of any new abstraction concrete and visible today — not hypothetical?
- Would skipping this change leave a real, noticeable problem in place?

If you cannot answer "yes" to at least two of these, omit the recommendation.

**Never propose** an abstraction for code used in only one place.
**Never propose** splitting a simple function just to satisfy a line-count heuristic.
**Never propose** an interface or base class where there is only one implementation and no
concrete, imminent second one.
**Never propose** restructuring working, readable code to fit an architectural pattern that
adds no value at this codebase's actual scale.
