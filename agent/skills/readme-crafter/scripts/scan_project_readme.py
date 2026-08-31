#!/usr/bin/env python3
"""README/config-specific parsing helpers for scan-project."""

from __future__ import annotations

import re
from pathlib import Path


def parse_env_map(path: Path | None) -> dict[str, str]:
    if path is None:
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = re.match(r"\s*([A-Z][A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def parse_readme_refs(readme_path: Path | None, root: Path) -> tuple[list[str], list[str]]:
    if readme_path is None:
        return [], []
    text = readme_path.read_text(encoding="utf-8", errors="ignore")
    refs = re.findall(r"\[[^\]]*]\(([^)]+)\)", text)
    refs += re.findall(r"""(?:src|href)=["']([^"']+)["']""", text)
    local_refs, missing = [], []
    for ref in refs:
        ref = ref.strip()
        if not ref or ref.startswith(("http://", "https://", "mailto:", "#", "data:", "<")):
            continue
        clean = ref.split("#", 1)[0].split("?", 1)[0]
        if clean:
            local_refs.append(clean)
            if not (root / clean).exists():
                missing.append(clean)
    return sorted(set(local_refs)), sorted(set(missing))


def parse_readme_imports(readme_path: Path | None, package_name: str | None, exports: set[str]) -> tuple[list[str], list[str], list[str]]:
    if readme_path is None:
        return [], [], []
    text = readme_path.read_text(encoding="utf-8", errors="ignore")
    import_paths = re.findall(r"""from\s+['"]([^'"]+)['"]""", text)
    internal_like = sorted({path for path in import_paths if path.startswith(("@/", "@kernel/", "src/", "./src/", "../src/"))})
    package_imports, unresolved = [], []
    if package_name:
        pattern = re.compile(rf"""import\s+\{{([^}}]+)\}}\s+from\s+['"]{re.escape(package_name)}['"]""")
        for body in pattern.findall(text):
            for item in body.split(","):
                item = item.strip()
                if item:
                    imported = item.split(" as ")[0].strip()
                    package_imports.append(item)
                    if imported not in exports:
                        unresolved.append(imported)
    return sorted(set(package_imports)), sorted(set(unresolved)), internal_like


def parse_readme_env_assignments(readme_path: Path | None) -> dict[str, str]:
    if readme_path is None:
        return {}
    values: dict[str, str] = {}
    for line in readme_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = re.search(r"([A-Z][A-Z0-9_]+)\s*=\s*(\S*)", line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def should_compare_env_value(key: str, value: str) -> bool:
    return bool(value) and (key.endswith(("_URL", "_BASE_URL", "_ENDPOINT", "_HOST")) or "://" in value)
