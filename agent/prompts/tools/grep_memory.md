Search this project's log — every session it has had — for the lines that match
a regular expression, and get their line numbers back. Reach for it before you
plan work the project may have done before: a feature, a release, a convention,
a bug, the file you were told not to touch. There is no path to choose here,
because there is exactly one file — this project's own log — so the only
decision is the pattern.

The log is the whole conversation this project has ever had: what the user asked,
what you answered, the tools that ran and what they came back with, one event per
line. Your context holds only the part since the newest compaction, so everything
older is here and nowhere else — including the reason behind a decision that
looks arbitrary now.

`pattern` is a Python regular expression, matched line by line (case-sensitive;
start it with `(?i)` for not). `include` keeps one KIND of line only:
`user_message` for what the user asked, `assistant_message` for what was
answered, `tool_call` / `tool_result` for what ran and what came back,
`compaction` for the summaries, `note` for facts an older build of this host
stored. `max_hits` (default 20, at most 200) caps the answer, and the footer says
when it stopped there — a narrower pattern is almost always better than more
hits.

Each hit is its line number, the line's kind and time, and the matching line of
that event, clipped. A hit is a pointer, not the story: read around it with
`read_memory` before you act on it. Read-only.
