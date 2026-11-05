Search this project's log — every earlier session in this project — for the lines
that match a regular expression, and get their line numbers back. CHAT MODE:
read-only, which is what this already is; it never writes anything.

`pattern` is a Python regular expression matched line by line (prefix `(?i)` for
case-insensitive). `include` keeps one KIND of line only — `user_message`,
`assistant_message`, `tool_call`, `tool_result`, `compaction`, `note` — and
`max_hits` (default 20, at most 200) caps the answer. Every hit is a line number,
the line's kind and time, and the matching line of that event, clipped. Read
around a hit with `read_memory`: an excerpt is a pointer, not the story.

Use it when the user refers to something that happened in an earlier session of
this project, or asks what was decided before — their words are in this log,
before they are in your context.
