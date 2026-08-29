# SOLID Principles

Five principles for designing classes and modules so that changes stay local and
the system remains easy to reason about as it grows. Formulated by Robert C. Martin.

Iterate each principle and its sub-points against the code under review. Apply only
when doing so concretely reduces complexity or makes the code easier to change safely.
Don't introduce abstractions speculatively — only when a real second case exists or
is immediately incoming.

---

## S — Single Responsibility Principle (SRP)

> A module should have one, and only one, reason to change.

"Reason to change" means: one actor or stakeholder whose requirements drive that module.
A class changed for both a business-logic reason *and* a database-schema reason has two
reasons to change — it should be split.

Check for:
- Classes or functions that mix concerns (e.g., business logic + persistence + formatting
  in the same function or class).
- Functions that are long because they handle multiple sequential, conceptually distinct
  responsibilities.
- Modules that are modified for unrelated reasons across different parts of the codebase.

Apply by separating concerns into distinct modules, each aligned with a single responsibility.
The split should make each piece easier to name, understand, and test in isolation.

**Caveat:** Don't over-split. A class with two tightly coupled methods that always change
together is not a SRP violation — SRP is about *reasons to change*, not line count.

---

## O — Open/Closed Principle (OCP)

> A module should be open for extension but closed for modification.

New behaviour should be addable without modifying existing, tested code. This is typically
achieved by depending on abstractions — so new behaviour arrives as a new implementation
rather than as edits to existing logic.

Check for:
- `if/switch` chains that grow every time a new variant is added, forcing edits to core logic.
- Business logic entangled with details that vary, making extension require touching stable code.

Apply by introducing an abstraction (interface, protocol, or higher-order function) at the
variation point, and let each variant implement it independently.

**Caveat:** Only apply when a second concrete case already exists or is immediately incoming.
An interface for a single implementation adds indirection with no benefit — that violates KISS.

---

## L — Liskov Substitution Principle (LSP)

> Subtypes must be substitutable for their base types without altering the correctness
> of the program.

If code accepts a base type, passing any subtype must work correctly — the caller should
not need to know or care which concrete subtype it received.

Check for:
- Subclasses that override methods and silently change their contract (e.g., throw exceptions
  the base type never does, ignore parameters, return a structurally different value).
- Callers that use `isinstance` or type-check before calling a method — a sign the subtype
  cannot be used as a drop-in replacement.
- Inheritance used purely for code reuse when no true "is-a" relationship holds semantically.

Apply by removing the invalid inheritance: use composition instead, or make the base type's
contract explicit and enforce it in every subtype. When inheritance only shares code rather
than expressing a substitution relationship, extract a shared helper instead.

---

## I — Interface Segregation Principle (ISP)

> Clients should not be forced to depend on methods they do not use.

A fat interface bundles unrelated methods together, forcing every implementor to implement
things it doesn't need and every caller to depend on a type that carries more than it uses.

Check for:
- Interfaces or abstract classes with many methods where individual callers use only a
  small, stable subset.
- Implementations that leave methods empty, raise `NotImplementedError`, or no-op them
  because they don't apply to that subtype.
- Modules that import a large class or interface just to use one or two of its methods.

Apply by splitting the fat interface into smaller, focused interfaces (or protocols).
Each client depends only on the slice it actually needs.

**Caveat:** Don't over-segregate. Two methods that always travel together and are always
used together belong in the same interface. Splitting them just to satisfy ISP adds
complexity without benefit.

---

## D — Dependency Inversion Principle (DIP)

> High-level modules should not depend on low-level modules. Both should depend on
> abstractions. Abstractions should not depend on details — details should depend on abstractions.

Business logic (high-level policy) should not reach directly into infrastructure (low-level
detail: databases, file systems, network clients, third-party SDKs). Both should depend on
an interface defined at the boundary. Infrastructure implements the interface; business logic
uses it — and knows nothing about the concrete implementation.

Check for:
- Business logic that directly instantiates database clients, HTTP clients, or file-system
  operations inside its own methods.
- Core modules that import from infrastructure modules (the import direction reveals the
  dependency direction).
- Functions that are hard to unit-test because they construct their own dependencies
  internally rather than receiving them.

Apply by:
1. Defining an interface (or abstract type) at the boundary between high-level and low-level.
2. Injecting the concrete dependency from outside — via parameter, constructor argument, or
   configuration — rather than constructing it internally.
3. Pointing imports inward: infrastructure imports the interface; business logic uses it.
   Neither imports the other directly.

**Caveat:** Not every function needs dependency injection. Pure functions and simple utilities
that have no infrastructure dependencies are fine as-is. Apply DIP where the dependency is on
something volatile (a database, an external API, a file system) that you'd want to swap or
mock independently.
