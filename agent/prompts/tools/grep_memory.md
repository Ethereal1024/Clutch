Search this project's log — every earlier session in this project — for the lines
that match a regular expression, and get their line numbers back.

The log is the whole conversation this project has ever had: what the user asked,
what you answered, the tools that ran and what they returned, one event per line.
Your context holds only the part since the newest compaction, so everything older
is here and nowhere else — the decision taken three sessions ago, the constraint
the user stated once, the file you were told not to touch.

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
