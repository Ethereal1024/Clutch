Read a page of this project's log by line number — the log `grep_memory` searches.
CHAT MODE: read-only, which is what this already is; it never writes anything.

With no `offset` you get the NEWEST `limit` lines (default 40, at most 200); with
an `offset` (1-based) you get the page starting there — the line a `grep_memory`
hit named, or the one a page's footer told you to ask for next. Each line arrives
as `line N  [kind time]` and then that event's own text, clipped, so a turn reads
as a turn. The footer says which range this page is and which `offset` continues
it or goes back.
