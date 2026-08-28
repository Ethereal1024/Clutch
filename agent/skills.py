"""Skills: load-on-demand domain knowledge (SKILL.md pattern from Claude Code / deepseek-harness).

A skill is a directory with a SKILL.md file carrying YAML frontmatter (name +
description). The model sees a lightweight catalog (name + description) in the
system prompt and decides whether to load a skill's full content via the
load_skill tool, keeping the base prompt lean (model-chosen context
augmentation, no keyword matching).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import List, Optional


@dataclass
class Skill:
    name: str
    description: str
    content: str
    dir: Path


@dataclass
class SkillLibrary:
    skills: List[Skill] = field(default_factory=list)

    def names(self) -> List[str]:
        return [s.name for s in self.skills]

    def get(self, name: str) -> Optional[Skill]:
        for s in self.skills:
            if s.name == name:
                return s
        return None

    def to_catalog_section(self) -> str:
        """One line per skill for the system prompt; the model picks what to load."""
        if not self.skills:
            return ""
        header = "Available skills (call load_skill to read one when relevant):"
        return header + "\n" + "\n".join(f"- {s.name}: {s.description}" for s in self.skills)


@lru_cache(maxsize=8)
def _load_cached(skills_dir: str) -> SkillLibrary:
    return load_skill_library(Path(skills_dir))


def cached_library(skills_dir: Path) -> SkillLibrary:
    return _load_cached(str(skills_dir))


def load_skill_library(skills_dir: Path) -> SkillLibrary:
    """Scan skills_dir for */SKILL.md files and parse name/description from frontmatter."""
    lib = SkillLibrary()
    if not skills_dir.exists():
        return lib
    for sk in sorted(skills_dir.iterdir()):
        skill_file = sk / "SKILL.md"
        if not skill_file.is_file():
            continue
        text = skill_file.read_text(encoding="utf-8")
        fm = _parse_frontmatter(text)
        lib.skills.append(
            Skill(
                name=fm.get("name", sk.name),
                description=fm.get("description", ""),
                content=fm.get("content", text),
                dir=sk,
            )
        )
    return lib


def _parse_frontmatter(text: str) -> dict:
    """Parse leading YAML-ish frontmatter; fall back to raw text when absent."""
    if not text.startswith("---"):
        return {"content": text}
    lines = text.splitlines()
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {"content": text}
    meta: dict = {}
    for line in lines[1:end]:
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip('"\'')
    meta["content"] = "\n".join(lines[end + 1 :]).strip()
    return meta
