"""The skill library: scan a root, parse frontmatter, read one file.

A skill is a directory holding a SKILL.md whose leading `---` block carries at
least `name` and `description`. A session only needs that catalog line to decide
what to load, and the body only when it actually loads one — which is why a whole
library can be served over three GETs.

Jurisdiction (ratified): this module owns the skill files. Nothing else walks the
tree, and the only paths it reads are files inside a skill directory under the
configured root — `name` selects a directory the scan already found (it is never
joined into a path), and `file` is contained by re-resolving it against that
directory. That containment is written here on purpose: borrowing the workspace
daemon's fence would couple two modules that must stay strangers.

Nothing in this file knows about HTTP or argv.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

MAX_FILE_BYTES = 1_000_000  # a skill file is prose; anything larger is a mistake
DEFAULT_SKILL_FILE = "SKILL.md"


class SkillError(Exception):
    """A request this library cannot serve, with a transport-free `code` the
    HTTP layer maps to a status and the CLI maps to an exit code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Skill:
    """One skill directory: its catalog line plus where its files live."""

    name: str
    description: str
    directory: str  # directory name under the root — what a client sees
    path: Path  # absolute, resolved directory


def checked_root(root: Path | str) -> Path:
    """The resolved skills root, or SkillError('no-root'). Resolved so that two
    spellings of the same directory (symlink, relative, trailing slash) serve —
    and key — the same library."""
    path = Path(root)
    if not path.is_dir():
        raise SkillError("no-root", f"skills root is not a directory: {path}")
    return path.resolve()


def catalog(root: Path | str) -> list[Skill]:
    """Every skill under `root`, ordered by directory name (stable output).

    A directory without a readable SKILL.md is simply not a skill and is skipped.
    A SKILL.md that exists but cannot be read as UTF-8 raises instead of being
    skipped: that is a broken file the operator must see, and hiding it would
    make one bad file look like a library that never had the skill.
    """
    base = checked_root(root)
    out: list[Skill] = []
    for entry in sorted(base.iterdir(), key=lambda p: p.name):
        if not entry.is_dir():
            continue
        skill_file = entry / DEFAULT_SKILL_FILE
        if not skill_file.is_file():
            continue
        meta, _ = parse_frontmatter(_read(skill_file, MAX_FILE_BYTES))
        out.append(
            Skill(
                name=meta.get("name") or entry.name,
                description=meta.get("description", ""),
                directory=entry.name,
                path=entry,
            )
        )
    return out


def find(root: Path | str, name: str) -> Skill:
    """The skill called `name` — matched against the scanned names and directory
    names, so a name can never be a path — or SkillError('unknown-skill')."""
    wanted = (name or "").strip()
    if not wanted:
        raise SkillError("unknown-skill", "name is required")
    for skill in catalog(root):
        if wanted in (skill.name, skill.directory):
            return skill
    raise SkillError("unknown-skill", f"unknown skill: {wanted}")


def read_text(
    root: Path | str,
    name: str,
    file: str = DEFAULT_SKILL_FILE,
    *,
    max_bytes: int = MAX_FILE_BYTES,
) -> tuple[Skill, str, str]:
    """One text file out of a skill directory: (skill, relative path, text).

    `file` stays inside the skill directory: absolute paths, `..`, and symlinks
    that leave it are all refused, and the target must be a regular file inside
    the size cap and decodable as UTF-8. The returned path is the resolved one,
    so an alias inside the directory never disguises which file was read.
    """
    skill = find(root, name)
    target = _contained(skill.path, file)
    if not target.is_file():
        raise SkillError("bad-file", f"not a file: {file}")
    return skill, _relative(skill.path, target), _read(target, max_bytes)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Leading YAML-ish frontmatter -> (meta, body).

    Deliberately the same reading the host's in-process loader has always done
    (flat `key: value` lines, quotes stripped, body = everything after the
    closing `---`), so a session sees the same skill text whichever side reads
    it. No frontmatter at all is legal: meta is empty and the body is the whole
    file, which leaves name = directory name and description = "".
    """
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:  # an opening fence with no close is content, not metadata
        return {}, text
    meta: dict[str, str] = {}
    for line in lines[1:end]:
        key, sep, value = line.partition(":")
        if sep:
            meta[key.strip()] = value.strip().strip("\"'")
    return meta, "\n".join(lines[end + 1 :]).strip()


def catalog_section(skills: list[Skill]) -> str:
    """The catalog as the one-line-per-skill block a system prompt embeds.

    Rendering lives with the session, not with the service: the service answers
    JSON, and this helper exists for the human CLI (and to keep the wording in
    one place).
    """
    if not skills:
        return ""
    header = "Available skills (call load_skill to read one when relevant):"
    return header + "\n" + "\n".join(f"- {s.name}: {s.description}" for s in skills)


# ---- internals --------------------------------------------------------------


def _contained(base: Path, rel: str) -> Path:
    """Resolve `rel` inside `base`, refusing every spelling that leaves it."""
    text = (rel or "").strip()
    if not text:
        raise SkillError("bad-file", "file is required")
    candidate = Path(text.replace("\\", "/"))
    if candidate.is_absolute():
        raise SkillError("escape", f"absolute paths are not allowed: {rel}")
    real_base = base.resolve()
    target = (real_base / candidate).resolve()  # resolve() follows symlinks too
    if target != real_base and real_base not in target.parents:
        raise SkillError("escape", f"path escapes the skill directory: {rel}")
    return target


def _relative(base: Path, target: Path) -> str:
    try:
        return target.relative_to(base.resolve()).as_posix()
    except ValueError:  # unreachable: _contained already proved containment
        return target.name


def _read(path: Path, max_bytes: int) -> str:
    """The file's text, or a code naming exactly what is wrong with it."""
    try:
        size = path.stat().st_size
    except OSError as err:
        raise SkillError("bad-file", f"cannot read {path.name}: {err}") from None
    if size > max_bytes:
        raise SkillError("too-large", f"{path.name} is {size} bytes (cap {max_bytes})")
    try:
        raw = path.read_bytes()
    except OSError as err:
        raise SkillError("bad-file", f"cannot read {path.name}: {err}") from None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise SkillError("not-text", f"{path.name} is not UTF-8 text") from None
