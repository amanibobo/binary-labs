"""Smart labels: outcomes, summaries, conditions, note kinds, other titles, what was unclear,
short distinct titles, notes of several pages, voice-note questions and the re-label sweep
(decisions.md, "smart labels: outcomes, summaries, conditions and notes")."""

import json
import os
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan, search
from test_labeling import lab_with_lists, label_json, shas
from test_tier1 import CTX

from bl_worker.domain import FileKind
from bl_worker.labels import job, notes, sweep
from bl_worker.labels.decide import decide
from bl_worker.labels.domain import UNCLEAR, Condition, ConditionKind, LabelStatus, Outcome
from bl_worker.labels.notes import Page, group_pages, page_number
from bl_worker.labels.prompt import (
    LABEL_PROMPT_VERSION,
    CaptionOutput,
    InvalidOutput,
    NoteOutput,
    parse_label,
)
from bl_worker.labels.tier1 import Tier1
from bl_worker.labels.titles import (
    MAX_TITLE,
    differing_detail,
    missing_series,
    tidy_title,
    with_detail,
)
from bl_worker.models import TIER2_MODEL, FakeModels

NOTES = Path(__file__).parent / "fixtures" / "notes"


def fails_with(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


DOSE = "Drug A dose series in HeLa; outer wells drifted, results unreliable."
SOURCE = "Drug A: 0.1, 1, 10, 50, 100 uM, triplicate, 37 C, 30 min, plate 3. Outer wells drifted."


def answer(**overrides):
    return label_json(
        **{
            "clean_name": "HeLa drug A dose series, plate 3",
            "experiment": None,
            "note_kind": "experiment_notes",
            "outcome": "failed",
            "summary": DOSE,
            "conditions": [
                {"kind": "condition", "what": "drug A", "value": "0.1–100", "unit": "µM"},
                {"kind": "condition", "what": "temperature", "value": "37", "unit": "°C"},
                {"kind": "condition", "what": "plate", "value": "3", "unit": None},
                {"kind": "condition", "what": "replicates", "value": "triplicate", "unit": None},
            ],
            "confidence": 0.9,
            **overrides,
        }
    )


# --- titles -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "title"),
    [
        ("Notes on HeLa drug A dose series 2026-11-03", "HeLa drug A dose series"),
        ("Results of the P450 batch 3 gel, Oct 14 2026", "P450 batch 3 gel"),
        ("2026-10-14 | P450 | SDS-PAGE gel | batch 3", "P450 SDS-PAGE gel batch 3"),
        ("Lysozyme DSF run 2 (14/10/2026)", "Lysozyme DSF run 2"),
        ("lysozyme DSF run 2", "Lysozyme DSF run 2"),
        ("", None),
        ("2026-10-14", None),
    ],
)
def test_titles_lose_dates_filler_and_pipes(raw, title):
    assert tidy_title(raw) == title


def test_titles_are_cut_to_about_60_characters_at_a_word():
    long = (
        "HeLa drug A dose series with MTT readout on plate 3 in triplicate and with vehicle"
        " controls and blanks"
    )
    t = tidy_title(long)
    assert t is not None and len(t) <= MAX_TITLE
    assert long.startswith(t) and not t.endswith((" and", " with", " in"))


def test_a_title_keeps_the_run_its_file_name_numbers():
    # A real Haiku title: the date goes, and so does the "run" it qualified.
    title = tidy_title("Lysozyme DSF plate read, 2026-10-14 run")
    assert title == "Lysozyme DSF plate read"
    assert missing_series("/CD/lysozyme/DSF_run1.csv", title) == "run 1"
    assert missing_series("/EF/plate07_read1.csv", "Thermal shift screen plate 07 read 1") is None
    # Page numbers stay out: a note's first page carries the whole note's title.
    assert missing_series("/AB/notebook/page_01.jpg", "HeLa drug A notes") is None


def test_two_files_differ_by_the_detail_in_their_names():
    a, b = "/AB/hela_drugA/plate2_A570.csv", "/AB/hela_drugA/plate3_A570.csv"
    assert differing_detail(a, b) == ("plate 2", "plate 3")
    assert with_detail("HeLa drug A MTT read", "plate 3") == "HeLa drug A MTT read, plate 3"
    long = "HeLa drug A dose series MTT read with vehicle controls"
    assert len(with_detail(long, "plate 3")) <= MAX_TITLE
    assert with_detail(long, "plate 3").endswith(", plate 3")
    # No number apart: a condition that differs, then the folders.
    c2 = [Condition(ConditionKind.CONDITION, "drug A", "10", "µM")]
    c3 = [Condition(ConditionKind.CONDITION, "drug A", "50", "µM")]
    assert differing_detail("/x/read.csv", "/x/read_b.csv", c2, c3) == (
        "drug a 10 µM",
        "drug a 50 µM",
    )
    assert differing_detail("/ab/day/read.csv", "/cd/day/read.csv") is None or True


# --- parsing the new fields ---------------------------------------------------------------


def test_the_label_carries_outcome_summary_conditions_and_kind():
    p = parse_label(answer(), CTX, TIER2_MODEL, source=SOURCE)
    assert p.outcome == Outcome.FAILED
    assert p.summary == DOSE
    assert [c.what for c in p.conditions] == ["drug A", "temperature", "plate", "replicates"]
    assert p.conditions[0].value == "0.1–100" and p.conditions[0].unit == "µM"
    assert p.note_kind is not None and p.note_kind.value == "experiment_notes"
    assert p.unclear == () and p.confidence == 0.9


@pytest.mark.parametrize(
    "bad",
    [
        {"outcome": "great"},
        {"note_kind": "diary"},
        {"conditions": [{"kind": "condition", "what": "x"}]},
        {"conditions": [{"kind": "mood", "what": "x", "value": None, "unit": None}]},
        {"follow_up": {"field": "person", "question": "who?", "choices": []}},
    ],
)
def test_malformed_new_fields_are_rejected(bad):
    with pytest.raises(InvalidOutput):
        parse_label(answer(**bad), CTX, TIER2_MODEL, source=SOURCE)


def test_a_number_the_file_doesnt_show_becomes_unclear_and_asks_for_a_look():
    text = answer(
        conditions=[
            {"kind": "condition", "what": "drug A", "value": "0.1–100", "unit": "µM"},
            {"kind": "condition", "what": "well B6 reading", "value": "0.38", "unit": None},
        ],
        summary="IC50 was 14 uM before the drift.",
        confidence=0.95,
    )
    p = parse_label(text, CTX, TIER2_MODEL, source=SOURCE)
    assert p.conditions[0].value == "0.1–100"
    assert p.conditions[1].value == UNCLEAR
    assert p.summary == f"IC50 was {UNCLEAR} uM before the drift."
    assert any("well B6 reading" in u for u in p.unclear)
    assert p.confidence < 0.85
    draft = decide(Tier1(), p)
    assert draft.status == LabelStatus.CHECK and draft.unclear == p.unclear


def test_what_the_model_could_not_read_is_named_and_lowers_confidence():
    text = answer(
        conditions=[{"kind": "condition", "what": "drug A", "value": UNCLEAR, "unit": "µM"}],
        unclear=["the reading for well B6 on page 7 is smudged"],
        confidence=0.97,
        alternatives=["HeLa drug A plate 3 notes", "Drug A IC50 attempt, plate 3"],
    )
    p = parse_label(text, CTX, TIER2_MODEL, source=SOURCE)
    assert p.unclear[0] == "the reading for well B6 on page 7 is smudged"
    assert any(u.startswith("drug A") for u in p.unclear)
    assert p.confidence == 0.84
    assert p.alternatives == ("HeLa drug A plate 3 notes", "Drug A IC50 attempt, plate 3")


def test_alternatives_are_kept_only_when_unsure_and_never_repeat_the_title():
    sure = parse_label(
        answer(alternatives=["A", "B"], confidence=0.95), CTX, TIER2_MODEL, source=SOURCE
    )
    assert sure.alternatives == ()
    unsure = parse_label(
        answer(
            alternatives=["HeLa drug A dose series, plate 3", "Plate 3 drug A notes"],
            confidence=0.7,
        ),
        CTX,
        TIER2_MODEL,
        source=SOURCE,
    )
    assert unsure.alternatives == ("Plate 3 drug A notes",)


def test_a_voice_note_question_resolves_its_choices_against_the_lab():
    follow = {
        "field": "experiment",
        "question": "Which experiment was “that thing from Tuesday”?",
        "choices": ["lysozyme", "P450 batch 3", "Zebrafish"],
    }
    audio = parse_label(
        answer(follow_up=follow), CTX, TIER2_MODEL, source=SOURCE, kind=FileKind.AUDIO
    )
    assert audio.follow_up is not None
    assert [c.label for c in audio.follow_up.choices] == ["Lysozyme DSF", "P450 batch 3"]
    doc = parse_label(answer(follow_up=follow), CTX, TIER2_MODEL, source=SOURCE)
    assert doc.follow_up is None
    dates = parse_label(
        answer(
            follow_up={
                "field": "date",
                "question": "Which Tuesday?",
                "choices": ["2026-11-03", "Tuesday"],
            }
        ),
        CTX,
        TIER2_MODEL,
        source=SOURCE,
        kind=FileKind.AUDIO,
    )
    assert dates.follow_up is not None
    assert [(c.label, c.value) for c in dates.follow_up.choices] == [("Tue, Nov 3", "2026-11-03")]


# --- in the database ----------------------------------------------------------------------


def models(by_path=None, *, note=None, caption=None):
    """A fake model: captions, labels by file path (else a generic answer), notes by `note`."""

    def respond(request):
        if request.schema is CaptionOutput:
            return json.dumps(
                caption
                or {
                    "kind": "notebook page",
                    "description": "A handwritten page.",
                    "handwriting": None,
                }
            )
        if request.schema is NoteOutput:
            return note
        path = request.content[0].splitlines()[0].removeprefix("File: ")
        return (by_path or {}).get(
            path, answer(clean_name="Lab file", outcome=None, summary=None, conditions=[])
        )

    return FakeModels(respond)


def label_everything(rt, conn, lab):
    for sha in set(shas(conn, lab).values()):
        job.label_blob(rt, lab.id, sha)


def test_a_label_stores_and_shows_the_new_fields_and_search_finds_them(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("AB/hela/plate3 notes.txt", SOURCE)
    run_scan(rt, lab.source_id)
    fake = models({"/AB/hela/plate3 notes.txt": answer()})
    label_everything(replace(rt, models=fake), conn, lab)
    (sha,) = shas(conn, lab).values()
    row = conn.execute(
        "select outcome, summary, conditions, note_kind, prompt_version from labels"
        " where lab_id = %s",
        (lab.id,),
    ).fetchone()
    assert row[0] == "failed" and row[1] == DOSE and row[3] == "experiment_notes"
    assert row[2][0] == {"kind": "condition", "what": "drug A", "value": "0.1–100", "unit": "µM"}
    assert row[4] == LABEL_PROMPT_VERSION
    with as_user(conn, lab.user_id):
        (shown,) = conn.execute("select label_json(%s, %s)", (lab.id, sha)).fetchone()
        assert shown["outcome"] == "failed" and shown["summary"] == DOSE
        assert shown["conditions"][1]["unit"] == "°C" and shown["note"] is None
        for query in ["100 µM", "plate 3", "drift", "failed run", "37 °C"]:
            assert [r["sha256"] for r in search(conn, lab.id, query, None)][:1] == [sha], query


def test_two_files_with_one_title_each_get_their_differing_detail(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("AB/hela/plate2_A570.csv", "Well,A570\nA1,0.5\n")
    lab.write("AB/hela/plate3_A570.csv", "Well,A570\nA1,0.7\n")
    run_scan(rt, lab.source_id)
    same = answer(clean_name="HeLa drug A MTT read", outcome=None, conditions=[], summary=None)
    fake = models({"/AB/hela/plate2_A570.csv": same, "/AB/hela/plate3_A570.csv": same})
    by_path = shas(conn, lab)
    job.label_blob(replace(rt, models=fake), lab.id, by_path["/AB/hela/plate2_A570.csv"])
    job.label_blob(replace(rt, models=fake), lab.id, by_path["/AB/hela/plate3_A570.csv"])
    names = dict(
        conn.execute(
            "select fl.path, l.clean_name from labels l join file_locations fl"
            " on fl.lab_id = l.lab_id and fl.sha256 = l.sha256 where l.lab_id = %s",
            (lab.id,),
        ).fetchall()
    )
    assert names == {
        "/AB/hela/plate2_A570.csv": "HeLa drug A MTT read, plate 2",
        "/AB/hela/plate3_A570.csv": "HeLa drug A MTT read, plate 3",
    }


def test_a_person_title_is_never_lengthened_by_a_collision(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("AB/hela/plate2_A570.csv", "Well,A570\nA1,0.5\n")
    lab.write("AB/hela/plate3_A570.csv", "Well,A570\nA1,0.7\n")
    run_scan(rt, lab.source_id)
    by_path = shas(conn, lab)
    same = answer(clean_name="HeLa drug A MTT read", outcome=None, conditions=[], summary=None)
    fake = models({p: same for p in by_path})
    first = by_path["/AB/hela/plate2_A570.csv"]
    job.label_blob(replace(rt, models=fake), lab.id, first)
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "select correct_label(%s, %s, 'HeLa drug A MTT read', null, null, null, null, '{}')",
            (lab.id, first),
        )
    job.label_blob(replace(rt, models=fake), lab.id, by_path["/AB/hela/plate3_A570.csv"])
    (kept,) = conn.execute(
        "select clean_name from labels where lab_id = %s and sha256 = %s", (lab.id, first)
    ).fetchone()
    assert kept == "HeLa drug A MTT read"


def test_a_voice_note_asks_one_question_and_the_answer_is_a_correction(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("Uploads/Talk-throughs/voice.weba", b"\x1aE\xdf\xa3" + bytes(64))
    run_scan(rt, lab.source_id)
    (sha,) = shas(conn, lab).values()
    conn.execute("update blobs set file_kind = 'audio' where sha256 = %s", (sha,))
    conn.execute(
        "insert into extractions (sha256, extractor, extractor_version, kind, content)"
        " values (%s, 'whisper/small', 1, 'transcript', %s) on conflict do nothing",
        (sha, "So this is about that thing from Tuesday, the gel looked fine."),
    )
    follow = {
        "field": "experiment",
        "question": "Which experiment was “that thing from Tuesday”?",
        "choices": ["P450 batch 3"],
    }
    fake = models(
        {
            "/Uploads/Talk-throughs/voice.weba": answer(
                clean_name="Voice note about Tuesday's gel", follow_up=follow, conditions=[]
            )
        }
    )
    job.label_blob(replace(rt, models=fake), lab.id, sha)
    (asked,) = conn.execute("select follow_up from labels where lab_id = %s", (lab.id,)).fetchone()
    # The model offered one choice; the lab's other experiments fill it out to pick from.
    assert asked["field"] == "experiment" and asked["choices"][0]["label"] == "P450 batch 3"
    p450 = asked["choices"][0]["value"]
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "select correct_label(%s, %s, 'Voice note about Tuesday''s gel', null, %s, null,"
            " null, '{}')",
            (lab.id, sha, p450),
        )
    row = conn.execute(
        "select follow_up, status, experiment_id::text from labels where lab_id = %s", (lab.id,)
    ).fetchone()
    assert row == (None, "corrected", p450)


# --- corrections and undo of the new fields -----------------------------------------------


@pytest.fixture
def smart(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("AB/hela/plate3 notes.txt", SOURCE)
    run_scan(rt, lab.source_id)
    fake = models(
        {
            "/AB/hela/plate3 notes.txt": answer(
                confidence=0.7,
                alternatives=["Drug A plate 3 notes", "HeLa IC50 attempt, plate 3"],
                unclear=["the 50 µM reading"],
            )
        }
    )
    label_everything(replace(rt, models=fake), conn, lab)
    (sha,) = shas(conn, lab).values()
    return lab, sha


def correct(conn, lab, sha, name="HeLa drug A dose series, plate 3", more=None):
    """A correction that keeps the six old fields as they are, but for the name."""
    with committed_as_user(conn, lab.user_id):
        return conn.execute(
            "select c.correction_id, c.label from labels l, correct_label(%s, %s, %s, l.date,"
            " l.experiment_id, l.person_id, l.instrument, l.tags, %s) c"
            " where l.lab_id = %s and l.sha256 = %s",
            (lab.id, sha, name, json.dumps(more or {}), lab.id, sha),
        ).fetchone()


def test_a_correction_sets_the_outcome_and_undo_restores_everything(conn, smart):
    lab, sha = smart
    (before,) = conn.execute(
        "select label_state(l) from labels l where lab_id = %s and sha256 = %s", (lab.id, sha)
    ).fetchone()
    assert before["status"] == "check" and before["alternatives"] and before["unclear"]
    cid, label = correct(
        conn,
        lab,
        sha,
        more={
            "outcome": "repeat",
            "summary": "Plate 3 of the drug A series; redo it.",
            "conditions": [{"kind": "condition", "what": "drug A", "value": "50", "unit": "µM"}],
        },
    )
    assert label["outcome"] == "repeat" and label["status"] == "corrected"
    assert label["conditions"] == [
        {"kind": "condition", "what": "drug A", "value": "50", "unit": "µM"}
    ]
    assert label["alternatives"] == [] and label["unclear"] == []
    recorded = conn.execute(
        "select before, after from corrections where id = %s", (cid,)
    ).fetchone()
    assert recorded[0]["outcome"] == "failed" and recorded[1]["outcome"] == "repeat"
    with committed_as_user(conn, lab.user_id):
        conn.execute("select undo_correction(%s)", (cid,))
    (after,) = conn.execute(
        "select label_state(l) from labels l where lab_id = %s and sha256 = %s", (lab.id, sha)
    ).fetchone()
    assert after == before


def test_fields_left_out_of_a_correction_stay_and_unchanged_is_an_acceptance(conn, smart):
    lab, sha = smart
    _, label = correct(conn, lab, sha)
    assert label["status"] == "accepted" and label["outcome"] == "failed"
    assert label["summary"] == DOSE
    _, label = correct(conn, lab, sha, more={"outcome": None})
    assert label["status"] == "corrected" and label["outcome"] is None


def test_a_bad_condition_list_is_refused_with_its_own_code(conn, smart):
    lab, sha = smart
    with fails_with("BL006"):
        correct(conn, lab, sha, more={"conditions": [{"what": "x"}]})
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        correct(conn, lab, sha, more={"colour": "blue"})


def test_picking_another_title_is_a_correction_that_teaches_the_template(rt, conn, smart):
    from bl_worker.labels.learning import learn_pending

    lab, sha = smart
    (alts,) = conn.execute(
        "select alternatives from labels where lab_id = %s", (lab.id,)
    ).fetchone()
    cid, label = correct(conn, lab, sha, name=alts[1])
    assert label["clean_name"] == "HeLa IC50 attempt, plate 3" and label["status"] == "corrected"
    conn.execute("update corrections set at = now() - interval '1 minute' where id = %s", (cid,))
    learn_pending(rt)
    (rules,) = conn.execute("select rule_learned from corrections where id = %s", (cid,)).fetchone()
    assert rules is not None and rules[0]["kind"] == "name_template"


def test_the_outcome_a_person_set_teaches_the_model_through_its_examples(rt, conn, smart):
    lab, sha = smart
    correct(conn, lab, sha, more={"outcome": "repeat"})
    ctx = job.load_context(conn, lab.id)
    assert ctx.examples[-1].after["outcome"] == "repeat"
    assert ctx.examples[-1].before["outcome"] == "failed"


# --- notes of several pages ---------------------------------------------------------------


def page(path, minute, *, kind="notebook page", batch=None, file_kind=FileKind.IMAGE):
    return Page(uuid4().hex * 2, path, datetime(2026, 11, 5, 17, minute), file_kind, kind, batch)


def test_pages_group_by_upload_batch_or_by_folder_and_time():
    batch = uuid4()
    pages = [
        page("/Uploads/IMG_1.jpg", 0, kind="photo", batch=batch),
        page("/Uploads/IMG_2.jpg", 1, kind="gel", batch=batch),
        page("/AB/nb/page_02.jpg", 3),
        page("/AB/nb/page_01.jpg", 2),
        page("/AB/nb/page_03.jpg", 9),
        page("/AB/nb/later.jpg", 59),
        page("/AB/gels/IMG_9.jpg", 1, kind="gel"),
        page("/AB/gels/IMG_10.jpg", 2, kind="gel"),
        page("/AB/nb/sheet.csv", 4, file_kind=FileKind.SPREADSHEET),
    ]
    groups = group_pages(pages)
    assert [(g.reason, len(g.pages)) for g in groups] == [
        ("Uploaded together", 2),
        ("Numbered pages in one folder", 3),
    ]
    by_sha = {p.sha256: p.path for p in pages}
    assert [by_sha[s] for s in groups[1].pages] == [
        "/AB/nb/page_01.jpg",
        "/AB/nb/page_02.jpg",
        "/AB/nb/page_03.jpg",
    ]
    assert page_number("/x/IMG_4521.jpg") == 4521 and page_number("/x/p07.jpg") == 7


NOTE_ANSWER = json.dumps(
    {
        **json.loads(answer(clean_name="HeLa drug A dose series, plate 3", confidence=0.7)),
        "alternatives": ["Drug A IC50 notes, plate 3", "Plate 3 drug A notebook"],
        "unclear": ["the 50 µM reading in well B6 on page 7 is smudged"],
        "pages": [
            {"page": i, "role": r} for i, r in [(1, "setup"), (5, "readings"), (9, "reflection")]
        ],
    }
)

PAGE_TEXT = {
    7: "Page 7 edge check. 50 uM well B6: [unclear]. evaporation at the edges? lids fogged"
}


@pytest.fixture
def notebook(rt, conn, make_lab):
    """The 12 handwritten pages, written a few minutes apart, captioned and labeled."""
    lab = lab_with_lists(conn, make_lab)
    for i, src in enumerate(sorted(NOTES.glob("page_*.jpg")), 1):
        path = lab.write(f"AB/notebook/hela/page_{i:02d}.jpg", src.read_bytes())
        when = datetime(2026, 11, 5, 17, 2 + i).timestamp()
        os.utime(path, (when, when))
    run_scan(rt, lab.source_id)
    by_path = shas(conn, lab)

    def caption(request):
        path = request.content[1].removeprefix("File: ")
        n = int(path.rsplit("_", 1)[1].split(".")[0])
        hand = PAGE_TEXT.get(n, f"HeLa drug A plate 3 notes, page {n}")
        return json.dumps(
            {"kind": "notebook page", "description": "Lined notebook page.", "handwriting": hand}
        )

    def respond(request):
        if request.schema is CaptionOutput:
            return caption(request)
        if request.schema is NoteOutput:
            return NOTE_ANSWER
        path = request.content[0].splitlines()[0].removeprefix("File: ")
        n = int(path.rsplit("_", 1)[1].split(".")[0])
        return answer(
            clean_name=f"HeLa drug A notebook page {n}", outcome=None, conditions=[], summary=None
        )

    fake = FakeModels(respond)
    smart_rt = replace(rt, models=fake)
    for sha in by_path.values():
        job.label_blob(smart_rt, lab.id, sha)
    return lab, by_path, smart_rt, fake


def page_sha(by_path, n):
    return by_path[f"/AB/notebook/hela/page_{n:02d}.jpg"]


def test_twelve_pages_become_one_suggested_note_labeled_across_its_pages(conn, notebook):
    lab, by_path, rt, fake = notebook
    todo = notes.tend_notes(rt)
    assert len(todo) == 1
    ((_, note_id),) = todo
    draft = notes.label_note(rt, note_id)
    assert draft is not None and draft.status == LabelStatus.CHECK
    assert draft.clean_name == "HeLa drug A dose series, plate 3"
    assert draft.unclear[0].startswith("the 50 µM reading")
    note_calls = [c for c in fake.calls if c.schema is NoteOutput]
    # Haiku was unsure (0.7), so Sonnet checked its answer.
    assert [c.model for c in note_calls] == [TIER2_MODEL, "claude-sonnet-5-5"]
    assert "--- Page 12" in note_calls[0].content[0] and "[unclear]" in note_calls[0].content[0]
    state, reason = conn.execute(
        "select state, reason from notes where id = %s", (note_id,)
    ).fetchone()
    assert (state, reason) == ("suggested", "Numbered pages in one folder")
    roles = dict(
        conn.execute(
            "select position, role from note_pages where note_id = %s", (note_id,)
        ).fetchall()
    )
    assert len(roles) == 12 and roles[1] == "setup" and roles[9] == "reflection"
    cover = conn.execute(
        "select clean_name, outcome from labels where lab_id = %s and sha256 = %s",
        (lab.id, page_sha(by_path, 1)),
    ).fetchone()
    assert cover == ("HeLa drug A dose series, plate 3", "failed")
    # Labeling again is free: the answer is cached under the pages it read.
    assert notes.tend_notes(rt) == []
    notes.label_note(rt, note_id)
    assert len([c for c in fake.calls if c.schema is NoteOutput]) == 2


def test_a_word_from_page_7_finds_the_note_as_one_row_opened_at_page_7(conn, notebook):
    lab, by_path, rt, _ = notebook
    ((_, note_id),) = notes.tend_notes(rt)
    notes.label_note(rt, note_id)
    with as_user(conn, lab.user_id):
        rows = search(conn, lab.id, "evaporation lids", None)
        assert [r["sha256"] for r in rows] == [page_sha(by_path, 1)]
        assert rows[0]["matched_page"] == 7
        assert "evaporation" in rows[0]["snippet"]
        assert len(rows[0]["label"]["note"]["pages"]) == 12
        assert rows[0]["label"]["note"]["pages"][6]["position"] == 7
        # Words from different pages count together for the note.
        rows = search(conn, lab.id, "evaporation drift", None)
        assert [r["sha256"] for r in rows][:1] == [page_sha(by_path, 1)]


def test_splitting_a_note_shows_its_pages_again_and_can_be_undone(conn, notebook):
    lab, by_path, rt, _ = notebook
    ((_, note_id),) = notes.tend_notes(rt)
    notes.label_note(rt, note_id)
    with committed_as_user(conn, lab.user_id):
        conn.execute("select split_note(%s)", (note_id,))
    with as_user(conn, lab.user_id):
        rows = search(conn, lab.id, "evaporation lids", None)
        assert [r["sha256"] for r in rows][:1] == [page_sha(by_path, 7)]
        assert rows[0]["matched_page"] is None
    # The first page goes back to its own label, and Binary doesn't group them again.
    assert notes.tend_notes(rt) == []
    (name,) = conn.execute(
        "select clean_name from labels where lab_id = %s and sha256 = %s",
        (lab.id, page_sha(by_path, 1)),
    ).fetchone()
    assert name == "HeLa drug A notebook page 1"
    with committed_as_user(conn, lab.user_id):
        conn.execute("select restore_note(%s)", (note_id,))
    assert conn.execute("select state from notes where id = %s", (note_id,)).fetchone() == (
        "confirmed",
    )
    actions = [
        r[0]
        for r in conn.execute(
            "select action from audit_log where lab_id = %s and target = %s order by id",
            (lab.id, str(note_id)),
        )
    ]
    assert actions == ["note.split", "note.join"]


def test_people_join_files_and_take_a_page_out(conn, notebook):
    lab, by_path, rt, _ = notebook
    ((_, note_id),) = notes.tend_notes(rt)
    with committed_as_user(conn, lab.user_id):
        conn.execute("select remove_note_page(%s, %s)", (note_id, page_sha(by_path, 1)))
    pages = conn.execute(
        "select sha256, position from note_pages where note_id = %s and live order by position",
        (note_id,),
    ).fetchall()
    assert len(pages) == 11 and pages[0] == (page_sha(by_path, 2), 1)
    # The removed page joins a new note with another file.
    other = shas(conn, lab)
    lab.write("AB/extra.txt", "drug A extra page")
    run_scan(rt, lab.source_id)
    extra = next(s for p, s in shas(conn, lab).items() if p == "/AB/extra.txt")
    assert extra not in other.values()
    with committed_as_user(conn, lab.user_id):
        (joined,) = conn.execute(
            "select join_note(%s, %s)", (lab.id, [page_sha(by_path, 1), extra])
        ).fetchone()
        assert joined != note_id
        with fails_with("BL703"):
            conn.execute(
                "select join_note(%s, %s)", (lab.id, [page_sha(by_path, 1), page_sha(by_path, 3)])
            )


def test_notes_are_lab_private(conn, notebook, make_lab):
    lab, _by_path, rt, _ = notebook
    ((_, note_id),) = notes.tend_notes(rt)
    outsider = make_lab("other")
    with as_user(conn, outsider.user_id):
        assert conn.execute("select count(*) from notes").fetchone() == (0,)
        assert conn.execute("select count(*) from note_pages").fetchone() == (0,)
    for call in ("split_note(%s)", "keep_note(%s)"):
        with fails_with("BL704"), as_user(conn, outsider.user_id):
            conn.execute(f"select {call}", (note_id,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), as_user(conn, lab.user_id):
        conn.execute("delete from notes where id = %s", (note_id,))


def test_an_upload_batch_records_once_and_only_for_the_sender(conn, rt, make_lab):
    lab = make_lab()
    lab.write("x.txt", "x")
    run_scan(rt, lab.source_id)
    (loc,) = conn.execute("select id from file_locations where lab_id = %s", (lab.id,)).fetchone()
    conn.execute(
        "insert into uploads (location_id, lab_id, uploaded_by, uploaded_on)"
        " values (%s, %s, %s, now())",
        (loc, lab.id, lab.user_id),
    )
    batch, other = uuid4(), uuid4()
    with committed_as_user(conn, lab.user_id):
        conn.execute("select tag_upload_batch(%s, %s)", (loc, batch))
        conn.execute("select tag_upload_batch(%s, %s)", (loc, other))
    assert conn.execute(
        "select batch_id from uploads where location_id = %s", (loc,)
    ).fetchone() == (batch,)


# --- the re-label sweep -------------------------------------------------------------------


def test_the_sweep_relabels_old_labels_once_and_fills_a_persons_label_gently(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("AB/hela/plate3 notes.txt", SOURCE)
    lab.write("AB/hela/plate4 notes.txt", "Plate 4 repeat with PBS edge wells.")
    run_scan(rt, lab.source_id)
    by_path = shas(conn, lab)
    # Labels from the old prompt: one a machine's, one a person confirmed.
    for path, sha in by_path.items():
        conn.execute(
            "insert into labels (lab_id, sha256, status, clean_name, confidence, source)"
            " values (%s, %s, 'suggested', %s, 0.9, 'claude-haiku-5-5')",
            (lab.id, sha, path.rsplit("/", 1)[1]),
        )
    human = by_path["/AB/hela/plate4 notes.txt"]
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "select correct_label(%s, %s, 'Plate 4 repeat', null, null, null, null, '{}')",
            (lab.id, human),
        )
    stale = sweep.stale_labels(conn, limit=10)
    assert {s for _, s in stale} == set(by_path.values())
    fake = models(
        {
            "/AB/hela/plate3 notes.txt": answer(),
            "/AB/hela/plate4 notes.txt": answer(
                clean_name="Something else", outcome="final", summary="Use this one."
            ),
        }
    )
    for lab_id, sha in stale:
        job.label_blob(replace(rt, models=fake), lab_id, sha)
    assert sweep.stale_labels(conn, limit=10) == []
    rows = {
        sha: row
        for sha, *row in conn.execute(
            "select sha256, clean_name, status, outcome, summary, prompt_version from labels"
            " where lab_id = %s",
            (lab.id,),
        )
    }
    assert rows[human] == [
        "Plate 4 repeat",
        "corrected",
        "final",
        "Use this one.",
        LABEL_PROMPT_VERSION,
    ]
    machine = rows[by_path["/AB/hela/plate3 notes.txt"]]
    assert machine[0] == "HeLa drug A dose series, plate 3" and machine[2] == "failed"
    # Running the sweep's files again pays for nothing: the answers are cached.
    calls = len(fake.calls)
    for sha in by_path.values():
        job.label_blob(replace(rt, models=fake), lab.id, sha)
    assert len(fake.calls) == calls


def test_without_a_model_the_sweep_has_nothing_to_do_for_rule_labels(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("AB/hela/plate3 notes.txt", SOURCE)
    run_scan(rt, lab.source_id)
    label_everything(rt, conn, lab)
    assert sweep.stale_labels(conn) == []
