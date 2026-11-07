Read a page of this project's log by line number — the log `grep_memory` searches.

With no `offset` you get the NEWEST `limit` lines (default 40, at most 200) —
usually the ones already in your context, so a question about the past starts
from a `grep_memory` hit, not here. With an `offset` (1-based) you get the page
starting at that line — the one a `grep_memory` hit named, or the one a page's
footer told you to ask for next.

Each line arrives as `line N  [kind time]` and then that event's own text, clipped
to keep a page readable, so a turn reads as a turn instead of as JSON. The footer
says which range this page is and which `offset` continues it — or goes back for
what came before. Read-only.
