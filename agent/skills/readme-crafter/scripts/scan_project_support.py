#!/usr/bin/env python3
"""Shared helpers for README-focused repository scanning."""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections import Counter
from fnmatch import fnmatch
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None


IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "vendor",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "dist",
    "build",
    "out",
    "target",
    ".next",
    ".nuxt",
    ".output",
    "coverage",
    ".cache",
    ".parcel-cache",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
}

CODE_EXTENSIONS = {
    ".py": "Python",
    ".js": "JavaScript",
    ".ts": "TypeScript",
    ".tsx": "TSX",
    ".jsx": "JSX",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".kt": "Kotlin",
    ".rb": "Ruby",
    ".php": "PHP",
    ".swift": "Swift",
    ".c": "C",
    ".cc": "C++",
    ".cpp": "C++",
    ".cs": "C#",
    ".sh": "Shell",
}

ENV_FILES = [".env.example", ".env.template", ".env.sample", ".env.defaults"]
LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md"]
README_FILES = ["README.md", "README.mdx", "readme.md"]


def run(cmd: list[str], cwd: Path) -> str:
    try:
        result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def section(title: str) -> None:
    print(f"\n── {title} ──\n")


def human_bytes(num: int) -> str:
    if num >= 1024 * 1024:
        return f"{num // (1024 * 1024)}MB"
    if num >= 1024:
        return f"{num // 1024}KB"
    return f"{num}B"


def load_ignore_patterns(root: Path) -> tuple[list[str], str | None]:
    for candidate in [".readme-crafterignore", ".readme-crafter-ignore"]:
        path = root / candidate
        if path.is_file():
            patterns = []
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    patterns.append(line.rstrip("/"))
            return patterns, candidate
    return [], None


def build_inventory(root: Path, ignore_patterns: list[str]) -> tuple[list[Path], str]:
    git_inventory = run(["git", "ls-files", "-co", "--exclude-standard"], root)
    if git_inventory:
        raw_paths = [Path(line) for line in git_inventory.splitlines() if line.strip()]
        mode = "git-aware (.gitignore + tracked files)"
    else:
        raw_paths = []
        for current_root, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in IGNORED_DIRS]
            rel_root = Path(current_root).relative_to(root)
            for filename in filenames:
                raw_paths.append((rel_root / filename) if str(rel_root) != "." else Path(filename))
        mode = "filesystem walk"

    filtered = []
    for path in raw_paths:
        posix = path.as_posix()
        if any(part in IGNORED_DIRS for part in path.parts):
            continue
        if any(fnmatch(posix, pattern) or fnmatch(posix, f"{pattern}/*") for pattern in ignore_patterns):
            continue
        filtered.append(path)
    return sorted(set(filtered)), mode


def read_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def read_toml(path: Path) -> dict:
    if not path.is_file() or tomllib is None:
        return {}
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError:
        return {}


def detect_first(root: Path, names: list[str]) -> Path | None:
    for name in names:
        path = root / name
        if path.is_file():
            return path
    return None


def summarize_languages(root: Path, inventory: list[Path]) -> list[str]:
    byte_counter: Counter[str] = Counter()
    file_counter: Counter[str] = Counter()
    for rel_path in inventory:
        label = CODE_EXTENSIONS.get(rel_path.suffix.lower())
        if not label or any(part in {"dist", "build", "coverage", "target"} for part in rel_path.parts):
            continue
        path = root / rel_path
        try:
            size = path.stat().st_size
        except OSError:
            continue
        byte_counter[label] += size
        file_counter[label] += 1
    return [
        f"  {label:<18} {file_counter[label]:>4} files  {human_bytes(size):>8}"
        for label, size in byte_counter.most_common(8)
    ] or ["  No code files detected"]


def select_js_entry(root: Path, package: dict) -> Path | None:
    candidates: list[str] = []
    exports = package.get("exports")
    if isinstance(exports, str):
        candidates.append(exports)
    elif isinstance(exports, dict):
        dot = exports.get(".")
        if isinstance(dot, str):
            candidates.append(dot)
        elif isinstance(dot, dict):
            for nested_key in ["import", "require", "default", "types"]:
                nested = dot.get(nested_key)
                if isinstance(nested, str):
                    candidates.append(nested)
    for key in ["module", "main", "types"]:
        value = package.get(key)
        if isinstance(value, str):
            candidates.append(value)
    candidates.extend(["src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.js"])
    root_resolved = root.resolve()
    for candidate in candidates:
        path = (root / candidate).resolve()
        try:
            rel = path.relative_to(root_resolved)
        except ValueError:
            continue
        if path.is_file():
            return rel
    return None


def resolve_local_module(root: Path, current: Path, target: str) -> Path | None:
    base = (root / current.parent / target).resolve()
    suffixes = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"]
    for suffix in suffixes:
        candidate = Path(str(base) + suffix) if suffix and not suffix.startswith("/") else base / suffix.lstrip("/")
        if candidate.is_file():
            try:
                return candidate.relative_to(root)
            except ValueError:
                return None
    return None


def collect_exports(root: Path, entry: Path) -> tuple[set[str], list[str]]:
    visited: set[Path] = set()
    exports: set[str] = set()
    notes: list[str] = []
    export_decl = re.compile(r"export\s+(?:declare\s+)?(?:async\s+)?(?:const|class|function|enum|interface|type)\s+([A-Za-z_]\w*)")
    export_list = re.compile(r"export\s+(?:type\s+)?\{([^}]+)\}(?:\s+from\s+['\"]([^'\"]+)['\"])?")
    export_all = re.compile(r"export\s+\*\s+from\s+['\"]([^'\"]+)['\"]")
    export_all_as = re.compile(r"export\s+\*\s+as\s+([A-Za-z_]\w*)\s+from\s+['\"]([^'\"]+)['\"]")

    def visit(rel_path: Path) -> None:
        if rel_path in visited or not (root / rel_path).is_file():
            return
        visited.add(rel_path)
        text = (root / rel_path).read_text(encoding="utf-8", errors="ignore")
        exports.update(export_decl.findall(text))
        for body, target in export_list.findall(text):
            for item in body.split(","):
                item = item.strip()
                if item:
                    exports.add(item.split(" as ")[-1].strip())
            if target and target.startswith("."):
                resolved = resolve_local_module(root, rel_path, target)
                if resolved:
                    visit(resolved)
        for target in export_all.findall(text):
            if target.startswith("."):
                resolved = resolve_local_module(root, rel_path, target)
                if resolved:
                    notes.append(f"re-export all: {resolved.as_posix()}")
                    visit(resolved)
        for alias, target in export_all_as.findall(text):
            exports.add(alias)
            if target.startswith("."):
                resolved = resolve_local_module(root, rel_path, target)
                if resolved:
                    visit(resolved)

    visit(entry)
    return exports, notes


def print_list(title: str, items: list[str], max_items: int = 12) -> None:
    print(f"  {title}:")
    if not items:
        print("    (none)")
        return
    for item in items[:max_items]:
        print(f"    - {item}")
    if len(items) > max_items:
        print(f"    - ... +{len(items) - max_items} more")
