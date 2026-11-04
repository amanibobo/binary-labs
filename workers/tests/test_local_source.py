import os

import pytest

from bl_worker.domain import SourceReadError
from bl_worker.sources.local import LocalFolderSource


def test_lists_nested_files_relative_to_root_and_skips_dotfiles(tmp_path):
    (tmp_path / "AB" / "P450" / "batch3").mkdir(parents=True)
    (tmp_path / "AB" / "P450" / "batch3" / "gel.jpg").write_bytes(b"x" * 10)
    (tmp_path / "notes.txt").write_text("hi")
    (tmp_path / ".DS_Store").write_bytes(b"junk")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref")
    os.symlink(tmp_path / "notes.txt", tmp_path / "link.txt")

    page = LocalFolderSource(tmp_path).list(None)

    assert [(e.external_id, e.path, e.name, e.size) for e in page.entries] == [
        ("notes.txt", "/notes.txt", "notes.txt", 2),
        ("AB/P450/batch3/gel.jpg", "/AB/P450/batch3/gel.jpg", "gel.jpg", 10),
    ]
    assert page.next_cursor is None and not page.has_more and page.deleted == []


def test_revision_is_size_and_mtime_ns_and_moves_when_the_file_changes(tmp_path):
    f = tmp_path / "a.csv"
    f.write_text("a,b\n")
    os.utime(f, ns=(1_000_000_000_123, 1_000_000_000_123))
    before = LocalFolderSource(tmp_path).list(None).entries[0].source_rev
    assert before == "4:1000000000123"
    f.write_text("a,b,c\n")
    assert LocalFolderSource(tmp_path).list(None).entries[0].source_rev != before


def test_reading_a_vanished_file_is_a_file_error(tmp_path):
    with pytest.raises(SourceReadError):
        LocalFolderSource(tmp_path).read("gone.pdf")
