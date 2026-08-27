"""Skills: load-on-demand domain knowledge (SKILL.md pattern from Claude Code / deepseek-harness).

A skill is a markdown file with YAML frontmatter (name + description). Skills whose
description keywords match the task are injected into the system prompt, keeping the
base prompt lean (dynamic context augmentation).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import List


@dataclass
class Skill:
    name: str
    description: str
    content: str
    path: Path


@dataclass
class SkillLibrary:
    skills: List[Skill] = field(default_factory=list)

    def match(self, task: str) -> List[Skill]:
        """Return skills whose description keywords appear in the task (case-insensitive)."""
        task_l = task.lower()
        words = re.split(r"[^a-z0-9]+", task_l)
        matched: List[Skill] = []
        for s in self.skills:
            desc_words = [w for w in re.split(r"[^a-z0-9]+", s.description.lower()) if len(w) > 2]
            if any(w in task_l or w in words for w in desc_words):
                matched.append(s)
        return matched

    def to_system_section(self, task: str) -> str:
        parts = []
        for s in self.match(task):
            parts.append(f"--- skill: {s.name} ---\n{s.content}")
        return "\n\n".join(parts)


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
                path=skill_file,
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
