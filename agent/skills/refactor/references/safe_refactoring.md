# Safe Refactoring Mode

Based on *Working Effectively with Legacy Code* by Michael Feathers.

Safe refactoring mode is a disciplined workflow that makes refactoring changes provably
safe — meaning you have automated evidence that the refactoring did not change observable
behaviour. It is the right approach whenever the codebase is large, the test coverage is
sparse or absent, or the code under change is critical and hard to reason about manually.

---

## Core Idea

Refactoring changes structure, not behaviour. The problem is: how do you *know* behaviour
was preserved if there are no tests? You write them first — not to verify correctness, but
to pin down exactly what the code currently does, warts and all. These are called
**characterization tests**.

Once characterization tests are in place and green, you refactor freely within the pinned
scope. If any test turns red, the refactoring changed behaviour — find out why before
continuing.

---

## Step-by-Step Workflow

### 1. Identify the Refactoring Scope

Before writing any test, be precise about what code will actually change:

- Which functions or methods will be modified, moved, split, or renamed?
- Which callers will be affected?
- What is the smallest boundary that contains all of that change?

This boundary is your **scope**. Everything inside the scope needs characterization tests.
Everything outside can be ignored for now.

Smaller scope → fewer tests needed → faster and safer iteration. If a recommendation
touches too many things at once, consider splitting it into smaller, independent steps.

---

### 2. Find Seams

A **seam** is a place in the code where you can observe or alter behaviour during a test
without editing the production code at that point. Seams are where your characterization
tests will attach.

Common seams:

- **Function/method boundaries** — call the function directly in a test and assert on
  its return value or observable side effects.
- **Object construction points** — if a class depends on something (a file, a database,
  a network call), inject a substitute in the test instead of the real thing.
- **Module-level boundaries** — import the module and call its public interface.

If the code under test has no seams (i.e., it directly creates its own dependencies and
cannot be called in isolation), you may need to introduce a seam first — before writing
tests and before refactoring. Common techniques:

- **Extract and override:** move the problematic dependency into a method that a test
  subclass or mock can override.
- **Parameter injection:** change the function to accept the dependency as a parameter
  instead of creating it internally. Pass the real dependency in production; pass a test
  double in the test.
- **Wrap the dependency:** introduce a thin wrapper around the external call so tests
  can substitute the wrapper.

Breaking dependencies to create seams is itself a small, careful structural change.
Do it before writing characterization tests, not after.

---

### 3. Write Characterization Tests

A characterization test captures what the code *actually does*, not what you think it
*should* do. You are not writing regression tests for correct behaviour — you are taking
a snapshot of current behaviour so that your refactoring cannot accidentally shift it.

**How to write one:**

1. Call the code through the seam you identified.
2. Run it. Observe the actual output, return value, or side effect.
3. Write an assertion that expects exactly that actual result — even if the result looks
   surprising or wrong. You are not fixing bugs here; you are pinning behaviour.
4. Run the test. It must pass against the unmodified code.

**What to cover:**

Cover the paths through the code that your refactoring will touch. You do not need 100%
branch coverage — you need enough coverage that a meaningful behavioural regression would
be caught. Focus on:

- The primary happy path through the scope.
- Any branching that the refactoring will restructure.
- Any output or side effect (file written, value returned, exception raised) that a caller
  depends on.

**What NOT to do:**

- Do not write assertions about what the code *should* do. Only assert what it *does*.
- Do not add new tests for untouched code paths — keep scope tight.
- Do not fix bugs you discover while writing the tests. Note them separately; address them
  after the refactoring is complete and tests are green.

---

### 4. Confirm Tests Are Green Before Touching Code

Run the characterization tests against the unmodified code. Every single one must pass.

If a test fails at this point, the test is wrong — fix the test, not the code.

Do not proceed to the refactoring step until all characterization tests are green on the
original code. Green on original = safe baseline established.

---

### 5. Refactor Within the Scope

Now apply the approved recommendation, changing only what falls within the identified scope.

- Make one logical change at a time when possible.
- Run the characterization tests after each logical step — don't wait until the end.
- If a test turns red: stop, understand why, and fix the regression before continuing.
  Do not comment out or weaken a failing test to make it pass.

---

### 6. Confirm Tests Are Still Green

When the refactoring is complete, run the full characterization test suite one final time.
All tests must pass. This is your proof that behaviour was preserved.

---

### 7. Decide the Fate of the Characterization Tests

Characterization tests served their purpose. Now decide:

- **Keep them** if they cover meaningful behaviour that would be valuable to protect going
  forward. Rename them to reflect what they actually test (not "characterization test for X").
- **Delete them** if they test implementation details that will be meaningless or misleading
  after the refactoring (e.g., they pin the internal structure of code that was just restructured).

If in doubt, keep them. Deleting a useful test is easy later; rewriting a lost test from
scratch after a regression is painful.

---

## When the Code Cannot Be Tested At All

Sometimes you encounter code so tightly coupled to its environment (global state, filesystem,
database, GUI) that there is simply no seam to attach a test to. Feathers calls this the
"I can't get this into a test harness" problem. In this situation:

1. Apply the minimum change needed to introduce a seam (parameter injection, thin wrapper,
   or extract-and-override).
2. This first change is done without test coverage — it is inherently risky, but it is the
   only way forward. Keep it as small as possible.
3. Once the seam exists, write characterization tests through it.
4. Now refactor safely from there.

Document this situation clearly in the `REFACTORING.md` recommendation so the user is
aware of the bootstrapping risk.

---

## Summary

| Step | Action | Code changes? |
|------|--------|---------------|
| 1 | Identify scope | No |
| 2 | Find / introduce seams | Only if required to make code testable |
| 3 | Write characterization tests | No |
| 4 | Confirm tests green on original | No |
| 5 | Refactor within scope | Yes |
| 6 | Confirm tests still green | No |
| 7 | Keep or delete tests | No |
