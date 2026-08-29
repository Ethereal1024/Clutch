Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.

The <prior-summary> (if any) summarizes everything that happened before the <conversation>. Construct a new summary that combines both; the <prior-summary> is discarded after this, so carry forward anything still needed. Where they conflict, the <conversation> is more recent and wins: state the corrected fact and drop the old claim. Move completed work from "Active" to "Completed"; update "Objective" and "Next Move" to reflect the current state.

Prior summary:
$previous_summary

<conversation>
$history
</conversation>
