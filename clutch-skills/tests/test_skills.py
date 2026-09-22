"""The skill library itself: scanning, frontmatter, and the containment fence.

These are the rules everything above (service, CLI, host) only relays, so they
are pinned directly — especially the refusals, which are the reason a skill name
can never become a path.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import write_skill

from clutch_skills import skills
from clutch_skills.skills import SkillError


def code_of(err: pytest.ExceptionInfo) -> str:
    return err.value.code


def test_catalog_lists_skill_directories_in_name_order(library: Path):
    assert [s.name for s in skills.catalog(library)] == ["alpha", "beta"]
    assert [s.directory for s in skills.catalog(library)] == ["alpha", "beta"]
    assert skills.catalog(library)[0].description == "the first skill"
    assert skills.catalog(library)[0].path == (library / "alpha").resolve()


def test_catalog_skips_directories_without_skill_md_and_loose_files(library: Path):
    names = [s.name for s in skills.catalog(library)]
    assert "gamma" not in names  # a directory without SKILL.md is not a skill
    assert "loose" not in names


def test_catalog_falls_back_to_directory_name_and_empty_description(library: Path):
    beta = next(s for s in skills.catalog(library) if s.directory == "beta")
    assert beta.name == "beta"
    assert beta.description == ""


def test_catalog_raises_on_an_unreadable_skill_md(library: Path):
    (library / "alpha" / "SKILL.md").write_bytes(b"\xff\xfe not utf-8")
    with pytest.raises(SkillError) as err:
        skills.catalog(library)
    assert code_of(err) == "not-text"  # broken, not silently absent


def test_catalog_of_an_empty_root_is_empty(tmp_path: Path):
    empty = tmp_path / "empty"
    empty.mkdir()
    assert skills.catalog(empty) == []
    assert skills.catalog_section([]) == ""


@pytest.mark.parametrize("root", ["missing", "file.txt"])
def test_checked_root_refuses_anything_that_is_not_a_directory(tmp_path: Path, root: str):
    (tmp_path / "file.txt").write_text("x", encoding="utf-8")
    with pytest.raises(SkillError) as err:
        skills.checked_root(tmp_path / root)
    assert code_of(err) == "no-root"


def test_checked_root_resolves_spellings_of_the_same_directory(library: Path):
    spelling = library / "gamma" / ".." / "."
    assert skills.checked_root(spelling) == library.resolve()


def test_find_accepts_the_frontmatter_name_or_the_directory_name(library: Path):
    write_skill(library, "delta", "---\nname: delta-alias\ndescription: aliased\n---\n\nbody\n")
    assert skills.find(library, "delta-alias").directory == "delta"
    assert skills.find(library, "delta").name == "delta-alias"


@pytest.mark.parametrize("name", ["", "  ", "nope"])
def test_find_refuses_an_unknown_or_empty_name(library: Path, name: str):
    with pytest.raises(SkillError) as err:
        skills.find(library, name)
    assert code_of(err) == "unknown-skill"


def test_read_text_defaults_to_skill_md_and_reads_relative_files(library: Path):
    skill, rel, text = skills.read_text(library, "alpha")
    assert skill.directory == "alpha"
    assert rel == "SKILL.md"
    assert "Alpha body text." in text
    _, rel, extra = skills.read_text(library, "alpha", "notes.md")
    assert rel == "notes.md"
    assert extra == "# Alpha notes\n\nWhat alpha knows beyond SKILL.md.\n"


def test_read_text_reads_a_nested_file_inside_the_skill(library: Path):
    nested = library / "alpha" / "sub"
    nested.mkdir()
    (nested / "deep.txt").write_text("deep\n", encoding="utf-8")
    _, rel, text = skills.read_text(library, "alpha", "sub/deep.txt")
    assert rel == "sub/deep.txt"
    assert text == "deep\n"


@pytest.mark.parametrize("bad", ["/etc/passwd", "../loose.txt", "sub/../../loose.txt", ""])
def test_read_text_refuses_every_spelling_that_leaves_the_skill(library: Path, bad: str):
    (library / "alpha" / "sub").mkdir()
    with pytest.raises(SkillError) as err:
        skills.read_text(library, "alpha", bad)
    assert code_of(err) in {"escape", "bad-file"}


def test_read_text_refuses_a_symlink_that_leaves_the_skill_directory(library: Path, tmp_path: Path):
    outside = tmp_path / "outside.md"
    outside.write_text("secret\n", encoding="utf-8")
    (library / "alpha" / "link.md").symlink_to(outside)
    with pytest.raises(SkillError) as err:
        skills.read_text(library, "alpha", "link.md")
    assert code_of(err) == "escape"


def test_read_text_follows_a_symlink_that_stays_inside_and_names_the_real_file(library: Path):
    (library / "alpha" / "alias.md").symlink_to(library / "alpha" / "notes.md")
    _, rel, text = skills.read_text(library, "alpha", "alias.md")
    assert rel == "notes.md"  # an alias never disguises which file was read
    assert text.startswith("# Alpha notes")


def test_read_text_refuses_a_missing_file_and_a_directory(library: Path):
    with pytest.raises(SkillError) as missing:
        skills.read_text(library, "alpha", "nope.md")
    assert code_of(missing) == "bad-file"
    (library / "alpha" / "sub").mkdir()
    with pytest.raises(SkillError) as directory:
        skills.read_text(library, "alpha", "sub")
    assert code_of(directory) == "bad-file"


def test_read_text_refuses_binary_and_oversized_files(library: Path):
    (library / "alpha" / "blob.bin").write_bytes(b"\xff\xfe\x00\x01")
    with pytest.raises(SkillError) as binary:
        skills.read_text(library, "alpha", "blob.bin")
    assert code_of(binary) == "not-text"
    (library / "alpha" / "big.txt").write_text("x" * 100, encoding="utf-8")
    with pytest.raises(SkillError) as big:
        skills.read_text(library, "alpha", "big.txt", max_bytes=10)
    assert code_of(big) == "too-large"


def test_parse_frontmatter_is_flat_keys_with_quotes_stripped():
    meta, body = skills.parse_frontmatter('---\nname: "quoted"\ndescription: plain\nfree: \'single\'\n---\n\nBody\n')
    assert meta == {"name": "quoted", "description": "plain", "free": "single"}
    assert body == "Body"


def test_parse_frontmatter_without_frontmatter_or_without_a_closing_fence():
    assert skills.parse_frontmatter("just text\n") == ({}, "just text\n")
    # an opening fence with no close is content, never metadata
    assert skills.parse_frontmatter("---\nname: x\n") == ({}, "---\nname: x\n")
    assert skills.parse_frontmatter("") == ({}, "")


def test_catalog_section_is_one_line_per_skill(library: Path):
    section = skills.catalog_section(skills.catalog(library))
    assert section.splitlines() == [
        "Available skills (call load_skill to read one when relevant):",
        "- alpha: the first skill",
        "- beta: ",
    ]


def test_no_other_clutch_module_is_imported():
    """R2: the star topology is a rule, not a habit — this package imports no
    sibling module, and never reaches outside its own tree."""
    package = Path(skills.__file__).parent
    for path in package.glob("*.py"):
        source = path.read_text(encoding="utf-8")
        for sibling in ("clutch_workspace", "clutch_memory", "clutch_websearch", "agent"):
            assert sibling not in source, f"{path.name} mentions {sibling}"
