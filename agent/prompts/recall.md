This project's memory is its own log: $name, $size of every session it has had,
and your context starts only at the newest compaction. What is older is not gone
— `grep_memory` searches all of it and `read_memory` reads it back line by line —
so look there before asking the user to repeat a decision, a preference, or a
constraint they already stated, and before re-deriving something this project
already settled.

Nothing has to be written down for a later session to find it: what you and the
user say and decide in this one is appended to that same log as it happens.
