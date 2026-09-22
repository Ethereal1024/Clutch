# clutch-memory

Project memories as a standalone one-shot CLI. The model's durable
per-project memories live inside the project's single `.clc` file; this
module reads and writes them through the agent server's **generic `.clc`
content endpoints** — it imports no host code and needs no daemon.

## The contract it speaks

Wire (agent server, local bind, no auth):

```
GET  /api/clc?lo=N&hi=N              -> {"size", "b64"}     raw bytes [lo, hi)
POST /api/clc/append  {"line"}       -> {"offset", "size"}  append one line
POST /api/clc/patch   {offset, b64}  -> {"size"}            in-place bytes only
```

File format (shared with the host; this module re-implements it, it does
not import it):

- header carries one **fixed-width** `memory_index=CC,HH,<16-digit offset>x10`
  line — a FIFO ring of the last 10 memory-line byte offsets;
- each memory is one JSONL line `{"title","content","updated"}` appended at
  the tail, scattered among the event lines;
- a save = append the line, then patch the index **in place** (the ring
  write never grows the file, so event offsets never shift).

The append endpoint hands back the **write offset**, so pointing the index
at the new line is race-free — no re-stat, no TOCTOU.

## CLI

```
python3 memory.py --endpoint http://127.0.0.1:<port> save   --title T --content C
python3 memory.py --endpoint http://127.0.0.1:<port> load   --title T
python3 memory.py --endpoint http://127.0.0.1:<port> search --query Q
python3 memory.py --endpoint http://127.0.0.1:<port> list
```

One JSON object on stdout. Exit codes: `0` ok, `1` not found, `2`
transport/protocol error.

## Tests

```
cd clutch-memory && python3 -m pytest
```

`tests/stub_server.py` serves the endpoint contract over a real file — the
contract pinned from the outside, independent of the host's implementation.
