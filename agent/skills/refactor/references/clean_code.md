# Clean Code Principles

Based on Robert C. Martin's *Clean Code*. Iterate every principle and its sub-points
against the code under review. Apply a sub-principle only when doing so concretely
reduces complexity for this specific code.

---

## 1. Meaningful Names

Names are the primary way code communicates intent. A good name eliminates the need
for a comment explaining what something does.

- **Reveal intention.** A name should tell you why it exists, what it does, and how it is
  used. If a name requires a comment, rename it.
- **Avoid disinformation.** Don't use names that suggest a type or concept the thing
  is not (e.g., `accountList` for something that isn't a list). Don't use look-alike
  names that differ by only one character.
- **Make meaningful distinctions.** Don't use noise words (`data`, `info`, `the`, `a`)
  that add nothing. `ProductData` and `ProductInfo` are indistinguishable.
- **Use pronounceable names.** If you can't say it aloud, it's hard to discuss in code review.
- **Use searchable names.** Single-letter variables and numeric constants are unsearchable.
  Use named constants for any value that has meaning.
- **Avoid encodings.** Don't prefix with type information (`strName`, `iCount`). Type
  systems and IDEs already know the type.
- **Avoid mental mapping.** A reader shouldn't have to translate your name into the
  concept it represents. Clarity over brevity.
- **Class names are nouns.** `Customer`, `WikiPage`, `Account` — not `Manager`,
  `Processor`, `Data`, or `Info`.
- **Method/function names are verbs.** `deletePage`, `save`, `isValid`, `getUser`.
- **One word per concept.** Don't use `fetch`, `retrieve`, and `get` as synonyms across
  the same codebase. Pick one and use it consistently.
- **Use domain vocabulary.** Prefer names from the problem domain (e.g., `Invoice`,
  `LedgerEntry`) or solution domain (e.g., `Queue`, `Visitor`) as appropriate.

---

## 2. Functions

Functions are the primary unit of behaviour. The cleaner each function, the easier the
whole system is to read.

- **Keep functions small.** A function should fit on one screen without scrolling. If it
  doesn't, consider whether it is doing more than one thing.
- **Do one thing.** A function should do one thing, do it well, and do it only. If you can
  extract a coherent sub-step with a meaningful name, the function is doing more than one
  thing.
- **One level of abstraction per function.** Mixing high-level orchestration with low-level
  detail in the same function makes it hard to read. Keep all statements at the same level
  of abstraction.
- **Descriptive names.** A long, descriptive name is better than a short, cryptic one. Don't
  be afraid of long function names if they capture intent precisely.
- **Minimise arguments.** Zero arguments is ideal. One is fine. Two is acceptable. Three
  requires strong justification. More than three almost always indicates the function should
  be redesigned. If multiple arguments belong together, consider a parameter object.
- **No side effects.** A function that is named `checkPassword` should check a password —
  not also initialise a session as a hidden side effect. Hidden side effects violate the
  principle of least surprise.
- **Command/query separation.** A function should either *do something* (command) or
  *return information* (query), never both. Mixed command/query functions are hard to reason about.
- **Prefer exceptions to error codes.** Returning error codes forces callers into nested
  conditionals. Exceptions let the happy path read cleanly and error handling sit in one place.
- **Don't repeat yourself.** If you see the same logic duplicated across functions, extract it.

---

## 3. Comments

A comment is a failure to express intent in code. The best comment is a well-named
function or variable that needs no explanation.

- **Don't comment bad code — rewrite it.** If you need a comment to explain what the
  code does, the code is not clear enough. Make it clear.
- **Good comments (keep these):**
  - Legal or licence headers.
  - Explanation of *why* a non-obvious decision was made (intent, not mechanics).
  - Warning of a consequence or constraint a reader would not anticipate.
  - TODO markers for known, tracked gaps.
- **Bad comments (remove these):**
  - Redundant comments that restate what the code already says clearly.
  - Misleading comments that no longer match the code they describe.
  - Mandated comments (e.g., boilerplate docstrings on every function regardless of value).
  - Journal/change-log comments — that's what version control is for.
  - Noise comments (`// Constructor`, `// End of loop`).
  - Commented-out code — delete it; history is in git.
  - Position markers (`///// SECTION 3 /////`) that reveal the function is too long.

---

## 4. Formatting

Formatting communicates structure. Consistent formatting makes the shape of the code
legible before the reader processes any words.

- **Vertical openness.** Separate distinct concepts with blank lines. Group related lines
  together without blank lines between them.
- **Vertical density.** Lines that belong together should sit together. Don't scatter
  related declarations across the file.
- **Vertical distance.** Variables should be declared close to where they are used.
  Dependent functions should live near each other — caller before callee.
- **Horizontal length.** Lines should be short enough to read without scrolling. Long
  lines often hide nested complexity.
- **Consistent indentation and style.** Use the project's established conventions. If none
  exist, establish one and apply it uniformly. Inconsistent style makes diffs noisy and
  trains readers to distrust their eye.

---

## 5. Objects and Data Structures

Choosing between exposing internal data versus hiding it behind behaviour is a key design decision.

- **Data abstraction.** Don't expose internal representation through getters and setters
  that mirror private fields one-for-one. Instead, expose an interface that reflects the
  *concept* the object represents, not its implementation.
- **Data/object anti-symmetry.** Procedural code (data structures + functions) makes it
  easy to add new functions without changing data shapes. Object-oriented code (objects with
  methods) makes it easy to add new types without changing existing functions. Choose the
  form that matches what is more likely to change.
- **Law of Demeter.** A method should only call methods on: itself, its parameters, objects
  it creates, or its direct components. Avoid chains like `a.getB().getC().doSomething()` —
  they couple you to the internal structure of objects you don't own.
- **Data Transfer Objects.** DTOs (plain data containers with no behaviour) are valid and
  useful at system boundaries. Don't force OO patterns onto things that are fundamentally data.

---

## 6. Error Handling

Error handling is necessary, but it must not obscure the primary logic.

- **Use exceptions, not error codes.** Error codes force callers to check and handle them
  immediately, cluttering the happy path. Exceptions let the normal flow read cleanly.
- **Provide context with exceptions.** Include enough information in the exception message
  to understand what failed and where. Don't throw bare `Exception("error")`.
- **Don't return null.** Returning null forces every caller to guard against it. Return a
  default value, an empty collection, or throw an exception instead.
- **Don't pass null.** Passing null into functions is similarly treacherous. If a value is
  truly optional, make that explicit in the type or use a dedicated option/maybe type.
- **Keep try-catch-finally bodies thin.** Extract the body of a try block into a named
  function. Try blocks read like flow-control, and nesting logic inside them makes them
  harder to scan.

---

## 7. Classes

Classes organise related behaviour and data. A class that is hard to describe without
using "and" is probably doing too much.

- **Keep classes small.** Measured not in lines but in *responsibilities*. A class with
  one clearly stated responsibility is small enough.
- **Single Responsibility Principle.** A class should have one and only one reason to
  change. If a class would need to be modified for multiple unrelated reasons (e.g., both
  a UI change and a persistence change), split it.
- **High cohesion.** The methods of a class should use most of the class's fields. If a
  subset of methods only uses a subset of fields, those methods likely belong in a separate class.
- **Organise for change.** Structure classes so that likely changes require modifications
  in as few places as possible. Isolate things that change from things that stay stable.
- **Favour composition over inheritance.** Inheritance creates tight coupling between parent
  and child. Prefer composing small, focused objects over building deep inheritance hierarchies.
