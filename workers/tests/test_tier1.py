from datetime import UTC, date, datetime
from uuid import uuid4

import pytest

from bl_worker.domain import FileKind
from bl_worker.labels.domain import (
    Experiment,
    FileInfo,
    LabContext,
    LabRule,
    Person,
    RuleKind,
    Strength,
)
from bl_worker.labels.tier1 import fill_template, make_template, name_skeleton, tier1

P450_3 = Experiment(uuid4(), "P450 batch 3", ("batch3",))
LYSO = Experiment(uuid4(), "Lysozyme DSF", ("lysozyme",))
PLATE7 = Experiment(uuid4(), "Thermal shift screen plate 07", ("screen_plate_07",))
AB = Person(uuid4(), "Ama Boateng", ("AB",))
CD = Person(uuid4(), "Chen Du", ("CD",))
CTX = LabContext((P450_3, LYSO, PLATE7), (AB, CD))
MODIFIED = datetime(2026, 3, 5, 12, tzinfo=UTC)


def file(path, kind=FileKind.TEXT, *, text="", meta=None, paths=(), readable=True):
    return FileInfo(
        lab_id=uuid4(),
        sha256="0" * 64,
        file_kind=kind,
        mime="x",
        paths=(path, *paths),
        modified_at=MODIFIED,
        text=text,
        meta=meta or {},
        readable=readable,
    )


@pytest.mark.parametrize(
    ("path", "meta", "expected", "strength"),
    [
        ("/CD/lysozyme/2026-10-14/notes.txt", {}, date(2026, 10, 14), Strength.STRONG),
        ("/Lab/AKTA/SEC_trace_141026.csv", {}, date(2026, 10, 14), Strength.STRONG),
        ("/Lab/run_20261014.csv", {}, date(2026, 10, 14), Strength.STRONG),
        ("/EF/meeting notes 10-21.md", {}, date(2026, 10, 21), Strength.MEDIUM),
        (
            "/AB/IMG_4821.jpg",
            {"exif": {"DateTimeOriginal": "2026:10:14 15:32:01"}},
            date(2026, 10, 14),
            Strength.STRONG,
        ),
        ("/AB/IMG_4821.jpg", {}, date(2026, 3, 5), Strength.WEAK),
        ("/Lab/run_311326.csv", {}, date(2026, 3, 5), Strength.WEAK),
    ],
)
def test_dates(path, meta, expected, strength):
    found = tier1(file(path, meta=meta), CTX).date
    assert found is not None and (found.value, found.strength) == (expected, strength)


@pytest.mark.parametrize(
    ("path", "experiment", "person"),
    [
        ("/AB/P450/batch3/gel notes.pdf", P450_3, AB),
        ("/CD/lysozyme/2026-10-14/DSF_run1.csv", LYSO, CD),
        ("/EF/thermal_shift/screen_plate_07/plate07_read1.csv", PLATE7, None),
        ("/lab meeting/batch notes.txt", None, None),  # "ab" inside "lab" is no one
        ("/protocols/SDS-PAGE.pdf", None, None),
    ],
)
def test_experiments_and_people_from_folders(path, experiment, person):
    t1 = tier1(file(path), CTX)
    assert (t1.experiment.value if t1.experiment else None) == experiment
    assert (t1.person.value if t1.person else None) == person


@pytest.mark.parametrize(
    ("path", "kind", "text", "meta", "instrument"),
    [
        ("/instrument/QuantStudio/run_0042.eds", FileKind.OTHER, "", {}, "QuantStudio"),
        ("/instrument/flow/sample_A1.fcs", FileKind.OTHER, "", {}, "Flow cytometer"),
        (
            "/AB/plate_A600_1.csv",
            FileKind.SPREADSHEET,
            "Sheet: csv\nSoftware Version | 3.11.19\nExperiment File Path | C:\\Gen5\\A600_1.xpt",
            {},
            "BioTek Gen5",
        ),
        (
            "/AB/IMG_4807.jpg",
            FileKind.IMAGE,
            "",
            {"exif": {"Make": "Bio-Rad", "Model": "ChemiDoc MP"}},
            "ChemiDoc MP",
        ),
        (
            "/AB/IMG_4821.jpg",
            FileKind.IMAGE,
            "",
            {"exif": {"Make": "Apple", "Model": "iPhone"}},
            None,
        ),
        ("/protocols/dsf.pdf", FileKind.PDF, "5x SYPRO on the QuantStudio", {}, None),
    ],
)
def test_instruments(path, kind, text, meta, instrument):
    t1 = tier1(file(path, kind, text=text, meta=meta), CTX)
    assert (t1.instrument.value if t1.instrument else None) == instrument


@pytest.mark.parametrize(
    ("header", "what"),
    [
        (["Well", "A600 (AU)", "Time (s)"], "plate read"),
        (["Well", "Fluorescence (AU)"], "DSF plate read"),
        (["Sample", "Conc (uM)", "Rate (nmol/min/mg)"], "kinetics"),
        (["Ligand", "Tm (C)", "dTm (C)"], "melting temperature summary"),
        (["Well", "Compound", "dTm (C)"], "thermal shift hits"),
    ],
)
def test_sheet_headers_say_what_a_table_is(header, what):
    meta = {"sheets": [{"name": "Kinetics", "header": header}]}
    t1 = tier1(file("/x/data.xlsx", FileKind.SPREADSHEET, meta=meta), CTX)
    assert t1.what is not None and t1.what.value == what
    assert "kinetics" in t1.tags


def test_a_copy_in_two_experiments_folders_is_a_conflict():
    t1 = tier1(file("/AB/P450/batch3/x.txt", paths=("/CD/lysozyme/x.txt",)), CTX)
    assert [c.split(":")[0] for c in t1.conflicts] == ["experiment", "person"]


def test_rules_build_a_name_only_when_they_know_what_and_whose():
    named = tier1(
        file(
            "/CD/lysozyme/2026-10-14/DSF_run2.csv",
            FileKind.SPREADSHEET,
            meta={"sheets": [{"name": "csv", "header": ["Well", "Fluorescence"]}]},
        ),
        CTX,
    )
    assert named.clean_name() == "Lysozyme DSF plate read, run 2"
    assert 0.5 <= named.confidence() <= 0.8
    unknown = tier1(file("/scratch/blob.bin", FileKind.OTHER, readable=False), CTX)
    assert unknown.clean_name() is None and unknown.confidence() == 0


def test_taught_folder_rules_beat_folder_aliases_and_the_deepest_wins():
    rules = (
        LabRule(RuleKind.FOLDER_EXPERIMENT, "/cd", experiment_id=P450_3.id),
        LabRule(RuleKind.FOLDER_EXPERIMENT, "/cd/lysozyme/old", experiment_id=PLATE7.id),
    )
    ctx = LabContext(CTX.experiments, CTX.people, rules)
    assert tier1(file("/CD/lysozyme/a.txt"), ctx).experiment.value == P450_3
    deep = tier1(file("/CD/lysozyme/old/a.txt"), ctx).experiment
    assert deep.value == PLATE7 and deep.strength == Strength.TAUGHT


def test_name_templates_fill_the_file_names_numbers():
    template = make_template("plate07_read1.csv", "Plate 07 thermal shift read 1")
    assert template == "Plate {0} thermal shift read {1}"
    assert fill_template("plate07_read3.csv", name_skeleton("plate07_read1.csv"), template) == (
        "Plate 07 thermal shift read 3"
    )
    assert fill_template("hits.xlsx", name_skeleton("plate07_read1.csv"), template) is None
    assert make_template("IMG_5003.jpg", "Lysozyme crystal photo") is None
