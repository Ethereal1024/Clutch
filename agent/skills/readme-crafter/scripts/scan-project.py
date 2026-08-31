#!/usr/bin/env python3
"""README-focused repository scanner for readme-crafter-skill."""

from __future__ import annotations

import re
import sys
from pathlib import Path

from scan_project_support import (
    ENV_FILES,
    LICENSE_FILES,
    README_FILES,
    build_inventory,
    collect_exports,
    detect_first,
    load_ignore_patterns,
    print_list,
    read_json,
    read_toml,
    run,
    section,
    select_js_entry,
    summarize_languages,
)
from scan_project_readme import (
    parse_env_map,
    parse_readme_env_assignments,
    parse_readme_imports,
    parse_readme_refs,
    should_compare_env_value,
)


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    if not root.is_dir():
        print(f"Error: '{root}' is not a directory", file=sys.stderr)
        return 1

    ignore_patterns, ignore_file = load_ignore_patterns(root)
    inventory, inventory_mode = build_inventory(root, ignore_patterns)
    package = read_json(root / "package.json")
    pyproject = read_toml(root / "pyproject.toml")
    readme_path = detect_first(root, README_FILES)
    env_path = detect_first(root, ENV_FILES)
    license_path = detect_first(root, LICENSE_FILES)
    js_entry = select_js_entry(root, package) if package else None
    exports, export_notes = collect_exports(root, js_entry) if js_entry else (set(), [])
    env_values = parse_env_map(env_path)
    env_keys = sorted(env_values.keys())
    readme_refs, missing_refs = parse_readme_refs(readme_path, root)
    package_name = package.get("name") if isinstance(package.get("name"), str) else None
    readme_package_imports, unresolved_imports, internal_like_imports = parse_readme_imports(readme_path, package_name, exports)
    readme_text = readme_path.read_text(encoding="utf-8", errors="ignore") if readme_path else ""
    readme_env_mentions = sorted(set(re.findall(r"\b[A-Z][A-Z0-9_]{2,}\b", readme_text)))
    readme_env_only = [key for key in readme_env_mentions if key.endswith(("_KEY", "_TOKEN", "_URL", "_BASE_URL")) and key not in env_keys]
    readme_env_values = parse_readme_env_assignments(readme_path)
    env_value_mismatches = sorted(
        key
        for key, value in readme_env_values.items()
        if key in env_values and should_compare_env_value(key, env_values[key]) and value and env_values[key] != value
    )

    print("╔══════════════════════════════════════════╗")
    print("║   README Crafter — Project Scan Report   ║")
    print("╚══════════════════════════════════════════╝\n")
    print(f"  Path: {root}")
    print(f"  Inventory: {inventory_mode}")
    if ignore_file:
        print(f"  Custom ignore: {ignore_file}")

    section("PROJECT IDENTITY")
    if package:
        print("  Source: package.json")
        for key in ["name", "version", "description", "license", "type", "packageManager", "private"]:
            if key in package:
                print(f"  {key}: {package[key]}")
        scripts = package.get("scripts", {})
        if isinstance(scripts, dict) and scripts:
            print_list("Scripts", [f"{name}: {value}" for name, value in scripts.items()], max_items=10)
    elif pyproject:
        project = pyproject.get("project", pyproject.get("tool", {}).get("poetry", {}))
        print("  Source: pyproject.toml")
        for key in ["name", "version", "description", "requires-python"]:
            if key in project:
                print(f"  {key}: {project[key]}")
    else:
        print("  No recognized package metadata found.")

    section("LANGUAGES")
    for row in summarize_languages(root, inventory):
        print(row)

    section("DISTRIBUTION & REPO POSTURE")
    posture_signals = []
    if js_entry:
        posture_signals.append(f"Library entry candidate: {js_entry.as_posix()}")
    if any((root / path).is_file() for path in ["vite.config.lib.ts", "vite.config.lib.js"]):
        posture_signals.append("Library build config present")
    if any((root / path).is_file() for path in ["src/main.tsx", "src/main.ts", "index.html"]):
        posture_signals.append("App/playground entry present")
    scripts = package.get("scripts", {}) if package else {}
    if isinstance(scripts, dict):
        if "dev" in scripts:
            posture_signals.append("Local dev script present")
        if "build:lib" in scripts:
            posture_signals.append("Dedicated library build script present")
    if package_name:
        posture_signals.append("Package name exists (intent signal, not publish proof)")
    if run(["git", "tag", "-l"], root):
        posture_signals.append("Git tags present")
    print_list("Signals", posture_signals)

    section("ENTRY POINTS")
    entry_points = [path.as_posix() for path in inventory if path.as_posix() in {
        "src/index.ts", "src/index.tsx", "src/index.js", "src/main.tsx", "src/main.ts",
        "src/App.tsx", "index.html", "main.py", "app.py", "cli.py", "__main__.py",
    }]
    if js_entry and js_entry.as_posix() not in entry_points:
        entry_points.insert(0, js_entry.as_posix())
    print_list("Entry points", entry_points)

    section("PUBLIC SURFACE")
    if js_entry:
        print(f"  Root entry: {js_entry.as_posix()}")
        print(f"  Exported symbols detected: {len(exports)}")
        if exports:
            print(f"  Export preview: {', '.join(sorted(exports)[:18])}")
        if export_notes:
            print_list("Re-export notes", export_notes, max_items=8)
    else:
        print("  No JS/TS library entry detected.")

    section("CONFIGURATION SURFACE")
    print(f"  Env example: {env_path.name if env_path else '—'}")
    print_list("Env keys", env_keys, max_items=20)

    section("README INTEGRITY SIGNALS")
    if readme_path:
        print(f"  README file: {readme_path.name}")
        print(f"  README lines: {len(readme_text.splitlines())}")
    else:
        print("  No README found.")
    print_list("Local refs in README", readme_refs, max_items=12)
    print_list("Missing local refs in README", missing_refs, max_items=12)
    if package_name:
        print_list(f"README imports from '{package_name}'", readme_package_imports, max_items=20)
    print_list("README internal-looking imports", internal_like_imports, max_items=10)
    print_list("README env vars not found in env example", readme_env_only, max_items=12)
    print_list("README env vars with different sample values", env_value_mismatches, max_items=12)

    section("LICENSE & TRUST SIGNALS")
    print(f"  License file: {license_path.name if license_path else '—'}")
    if package:
        print(f"  package.json license: {package.get('license', '—')}")
    if not license_path and package.get("license"):
        print("  Risk: metadata claims a license but no license file exists")
    if license_path and package.get("license"):
        print("  Check: ensure README, package metadata, and license file all agree")

    section("GIT METADATA")
    print(f"  Remote: {run(['git', 'remote', 'get-url', 'origin'], root) or '—'}")
    print(f"  Branch: {run(['git', 'symbolic-ref', '--short', 'HEAD'], root) or '—'}")
    print(f"  Commits: {run(['git', 'rev-list', '--count', 'HEAD'], root) or '0'}")
    print(f"  Latest tag: {run(['git', 'describe', '--tags', '--abbrev=0'], root) or '—'}")

    section("README RISK SUMMARY")
    risks = []
    if missing_refs:
        risks.append(f"README references missing local files: {', '.join(missing_refs[:5])}")
    if unresolved_imports:
        risks.append(f"README imports symbols not found in root export surface: {', '.join(unresolved_imports[:8])}")
    if internal_like_imports:
        risks.append(f"README contains internal-looking import paths: {', '.join(internal_like_imports[:5])}")
    if readme_env_only:
        risks.append(f"README mentions env vars missing from env example: {', '.join(readme_env_only[:8])}")
    if env_value_mismatches:
        risks.append(f"README sample config values differ from env example: {', '.join(env_value_mismatches[:8])}")
    if not license_path and package.get("license"):
        risks.append("License metadata exists but no root license file was found")
    for risk in risks or ["No obvious README-to-repo mismatches detected by the scanner"]:
        print(f"  - {risk}")

    print("\n╔══════════════════════════════════════════╗")
    print("║            Scan complete                 ║")
    print("╚══════════════════════════════════════════╝")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
