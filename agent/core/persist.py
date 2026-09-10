""".clc line-append persistence: one shared append_jsonl helper.

"Append a JSONL line to the .clc, optionally routed through a writer callback
(the SSH degradation layer's exec bridge)" is a single piece of knowledge shared
by the event log (LazyEventLog.append), the memory store (MemoryStore._append) and
the project writers. Local callers pass writer=None and get a plain
open(path, "a"); remote callers pass workspace.append_line so the append happens
on the remote host.
"""

from __future__ import annotations

from typing import Callable

# writer(path, line) persists one line instead of the local file append
LineWriter = Callable[[str, str], None]


def append_jsonl(path: str, line: str, writer: LineWriter | None = None) -> None:
    """Append one JSONL line to ``path``: through ``writer`` when given (remote
    bridge), else via a local open(path, "a").

    newline="\\n" pins the line terminator to ONE byte on every host: the file is
    BYTE-addressed (event offsets + the persisted window start), so Windows'
    text-mode translation (\\n -> \\r\\n) would make every stored offset drift by
    one byte per line — and the remote bridge writes LF anyway, so this keeps
    both storage backends byte-identical.
    """
    if writer is not None:
        writer(path, line)
    else:
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")
