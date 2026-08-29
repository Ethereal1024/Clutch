# Clean Architecture Principles

Based on Robert C. Martin's *Clean Architecture* and *Agile Software Development*.
These principles operate at the module and system level. Iterate each principle and
sub-point against the code under review. Apply only when it addresses a real, present
structural problem — not to satisfy a pattern for its own sake.

---

## SOLID Principles

See `references/solid.md` for the full detail on all five SOLID principles (SRP, OCP, LSP,
ISP, DIP). They govern class- and module-level design and are listed as a top-level principle
in the skill — iterate them before applying the component-level principles below.

---

## Component Cohesion Principles

These govern which modules or classes belong together in the same component (package,
library, or deployment unit).

### REP — Reuse/Release Equivalence Principle

> The granule of reuse is the granule of release.

Things that are released together should be reusable together. A component should contain
only classes and modules that are released as a coherent group — if one changes, all are
released together.

Check for: components that bundle unrelated classes that evolve for different reasons and
would be versioned independently if possible.

### CCP — Common Closure Principle

> Gather into components the classes that change for the same reasons and at the same times.
> Separate into different components the classes that change at different times for different reasons.

This is SRP applied at the component level. Classes that change together should live together.

Check for: changes that ripple across many components because related classes are spread thin.

### CRP — Common Reuse Principle

> Don't force users of a component to depend on things they don't need.

Don't put classes that are not closely related into the same component — it forces everyone
who uses any part of the component to redeploy when any part of it changes.

Check for: components where callers only use a small subset of what the component contains.

**Tension:** REP and CCP push toward larger components; CRP pushes toward smaller ones.
The right balance depends on how much the project values reusability vs. development ease.

---

## Component Coupling Principles

These govern how dependencies between components are structured.

### ADP — Acyclic Dependencies Principle

> Allow no cycles in the component dependency graph.

Cyclic dependencies between components make them impossible to build, test, or release
independently. A change in any component in the cycle forces all others to change.

Check for: component A imports B, B imports C, C imports A (directly or transitively).

Apply by breaking the cycle: extract the shared dependency into a third component that
both depend on, or introduce an interface (applying DIP) to invert one of the dependencies.

### SDP — Stable Dependencies Principle

> Depend in the direction of stability.

A stable component is one that many things depend on and few things depend upon — it is
hard to change. An unstable component is one that depends on many things and few depend
on — it is easy to change. Volatile components (those likely to change) should depend on
stable components, not the other way around.

Check for: stable, foundational modules that depend on volatile, frequently-changing modules.

### SAP — Stable Abstractions Principle

> A component should be as abstract as it is stable.

Stable components (hard to change because many depend on them) should consist of
abstractions (interfaces, abstract classes) — so that stability doesn't mean rigidity.
Unstable components (free to change) can be concrete.

Check for: stable components that are entirely concrete (no interfaces), making them
impossible to extend without modification; or abstract components that are unstable
(no one depends on them, so the abstraction serves no purpose).

---

## The Dependency Rule

The overarching rule that ties these principles together in a layered architecture:

> **Source code dependencies must point only inward, toward higher-level policy.**

The canonical layers (from outer to inner):
1. **Frameworks & Drivers** — web frameworks, databases, UI, external tools. Most volatile.
2. **Interface Adapters** — controllers, presenters, gateways. Translate between inner and outer.
3. **Use Cases (Application Business Rules)** — application-specific business rules.
4. **Entities (Enterprise Business Rules)** — core domain objects and rules. Most stable.

Nothing in an inner layer knows anything about an outer layer. Outer layers implement
interfaces defined by inner layers — this is how the dependency rule is enforced while
still allowing data to flow in both directions at runtime.

Check for:
- Business logic (use cases or entities) that imports from web frameworks, ORMs, or
  third-party libraries.
- Database models leaking into the application layer or domain.
- Use-case code that knows what HTTP status codes are.

Apply by defining interfaces at layer boundaries and injecting implementations from outside.
Data crossing layer boundaries should be converted to simple data structures (DTOs) rather
than passing framework or infrastructure objects inward.
