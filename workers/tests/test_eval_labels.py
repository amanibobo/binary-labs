import importlib.util
from pathlib import Path

from bl_worker.labels.evaluate import load_expected, name_ok

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "make_sample_lab.py"


def test_every_sample_lab_file_has_a_hand_written_label(tmp_path):
    spec = importlib.util.spec_from_file_location("make_sample_lab", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.make(tmp_path)
    on_disk = {"/" + p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file()}
    expected = [p for item in load_expected()["files"] for p in item["paths"]]
    assert sorted(expected) == sorted(on_disk)
    contents = {}
    for item in load_expected()["files"]:
        blobs = {(tmp_path / p.lstrip("/")).read_bytes() for p in item["paths"]}
        assert len(blobs) == 1, item["paths"]
        assert blobs.isdisjoint(contents), item["paths"]
        contents |= dict.fromkeys(blobs)


def test_name_terms_need_every_term_and_any_alternative():
    terms = [["plate 07", "plate 7"], "read 2"]
    assert name_ok(terms, "Screen plate07 DSF read 2")
    assert not name_ok(terms, "Screen plate 07 DSF read 3")
    assert not name_ok(terms, None)
