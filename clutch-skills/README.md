# clutch-skills

The skill library as a standalone service. A skill is a directory holding a
`SKILL.md`; a session needs only `name` + `description` to decide what to load,
and the body only when it actually loads one. This module owns those files and
answers those three questions — catalog, one file, a re-pointed root — over
loopback HTTP, stdlib only, importing no host code.

```
clutch-skills/skills/       the bundled root (any root can be served instead)
clutch-skills/clutch_skills/
  skills.py                 the library: scan, frontmatter, containment, read
  server.py                 the service: HTTP skin over the library
  client.py                 thin client: find or lazily start a daemon
  discovery.py              how a caller finds the daemon for a root
  cli.py                    flags -> service -> stdout
```

## CLI

```
python3 -m clutch_skills [--json] [--root DIR] list
python3 -m clutch_skills [--json] [--root DIR] show NAME [--file REL]
python3 -m clutch_skills [--json] [--root DIR] root [DIR]
python3 -m clutch_skills [--json] [--root DIR] health
```

Exit codes: `0` ok, `1` the library refused (unknown skill, bad or unreadable
file, a root that is not a directory), `2` usage error or transport trouble.
`--json` always emits **one** JSON object on stdout for both outcomes, so a
caller parses stdout plus the exit code and never prose. `show` prints the file
verbatim (exactly one trailing newline at most), so it can be piped into a file
and diffed.

`--no-server` answers `list` and `show` from the filesystem in this one process
and starts nothing; `health` and `root` are refused there, because the answer IS
daemon state. `--url`/`--port` talk to a service you already know instead of
discovering one.

## The wire contract

One daemon per root, `127.0.0.1`, no auth (nothing here is worth a token: the
service reads only inside the root it was pointed at, and its one mutation is
re-pointing itself):

```
GET  /health                -> {"ok", "root", "pid", "skills"}
GET  /skills                -> {"root", "skills": [{"name","description","dir"}]}
GET  /skill?name=&file=     -> {"root","name","description","dir","file","content"}
POST /root {"root": DIR}    -> {"ok", "root", "skills"}      re-point, no restart
```

Here the status codes carry the meaning: `200` ok, `400` a caller-fixable
request (missing field, bad file, escape, non-UTF-8, a root that is not a
directory), `404` an unknown skill or path. The `404` for a skill carries
`"available": [names]`, so a caller that guessed a name can answer with the real
ones instead of failing blind. Nothing is cached: editing a `SKILL.md` takes
effect on the next request. A daemon exits after `--idle` seconds without a
request (default 600) and on `SIGTERM`/`SIGINT`, and both paths remove its
discovery file.

## Rules the service keeps

- **name is never a path** — `name` selects a directory the scan already found;
  `file` is re-resolved against that directory, and absolute paths, `..`, and
  symlinks that leave the skill are refused;
- **a skill that is broken is loud** — a directory without `SKILL.md` is skipped
  silently, but a `SKILL.md` that cannot be decoded as UTF-8 raises instead of
  vanishing from the catalog;
- **bounded reads** — 1 MB per file (`MAX_FILE_BYTES`), and a file that is not
  UTF-8 text is a named refusal, not a mojibake answer;
- **stable output** — skills come back ordered by directory name;
- **no shared state with the other modules** — containment is written here on
  purpose; borrowing the workspace daemon's fence would couple two modules that
  must stay strangers.

## Rendezvous

`~/.clutch-skills/s-<sha256(root)[:32]>.json` (`CLUTCH_SKILLS_DISCOVERY_DIR`
overrides the directory; `%LOCALAPPDATA%` on Windows) holds root, port, pid and
start time. Two spellings of the same directory land on one file, a stale entry
whose pid is dead is removed on read, and the CLI reuses a live daemon or starts
one detached and waits for it to publish itself.

## Tests

```
cd clutch-skills && python3 -m pytest
```

`tests/conftest.py` gives every test its own discovery directory and reaps the
daemons it started; `tests/test_server.py` drives a real daemon process over
real HTTP, `tests/test_cli.py` drives `python -m clutch_skills` as a subprocess.
