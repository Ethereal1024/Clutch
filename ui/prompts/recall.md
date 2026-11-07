This project's memory is its own log: $name, $size of every session it has had,
and your context starts only at the newest compaction. Everything older is in
that file and in no message you can see — so search it with `grep_memory` before
you plan work this project may have already settled, and read the lines around a
hit with `read_memory`. A decision taken three sessions ago, a constraint the
user stated once, the file you were told not to touch: they are in the log, and
looking them up is cheaper than re-deriving them or asking the user to repeat
what they already said.

There is no save tool and nothing to save. What you and the user say and decide
in this session is appended to that same log as it happens; if a fact should
outlive this session, say it plainly here, because that is what a later session
reads.

A tool name that appears in the transcript or in a summary is history, not an
offer: call the tools in this request's tool list, and nothing else.
