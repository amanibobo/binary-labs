import json
from dataclasses import replace

import pytest
from conftest import committed_as_user, run_scan, search

from bl_worker import samples
from bl_worker.domain import FileKind
from bl_worker.labels import job
from bl_worker.labels.decide import decide, status_for, tier3_reason
from bl_worker.labels.domain import LabContext, LabelStatus, Proposal
from bl_worker.labels.learning import learn_pending
from bl_worker.labels.prompt import CaptionOutput, InvalidOutput, parse_label
from bl_worker.labels.tier1 import Tier1
from bl_worker.models import TIER2_MODEL, TIER3_MODEL, FakeModels, Image

from test_tier1 import CTX, LYSO, P450_3, file


def label_json(**overrides):
    out = {
        "clean_name": "Lysozyme DSF run 1",
        "date": "2026-10-14",
        "experiment": "Lysozyme DSF",
        "person": None,
        "instrument": None,
        "tags": ["dsf"],
        "confidence": 0.9,
        "reason": "folder and content agree",
    }
    return json.dumps({**out, **overrides})


def proposal(confidence, **kw):
    return replace(parse_label(label_json(confidence=confidence), CTX, TIER2_MODEL), **kw)


@pytest.mark.parametrize(
    ("confidence", "status"),
    [
        (1.0, LabelStatus.SUGGESTED),
        (0.85, LabelStatus.SUGGESTED),
        (0.8499, LabelStatus.CHECK),
        (0.5, LabelStatus.CHECK),
        (0.4999, LabelStatus.NEEDS_LOOK),
        (0.0, LabelStatus.NEEDS_LOOK),
    ],
)
def test_confidence_routing_at_the_prd_thresholds(confidence, status):
    assert status_for(confidence) == status
    draft = decide(Tier1(), proposal(confidence))
    assert draft.status == status
    assert (draft.clean_name is None) == (status == LabelStatus.NEEDS_LOOK)


@pytest.mark.parametrize(("confidence", "goes_on"), [(0.85, False), (0.8499, True), (0.5, True)])
def test_tier3_runs_only_under_the_bar(confidence, goes_on):
    f = file("/CD/lysozyme/2026-10-14/DSF_run1.csv", FileKind.SPREADSHEET)
    t1 = Tier1()
    assert (tier3_reason(f, t1, proposal(confidence)) is not None) == goes_on


def test_tier3_runs_for_unknown_formats_and_disagreements():
    from test_tier1 import tier1

    f = file("/CD/lysozyme/2026-10-14/DSF_run1.csv", FileKind.SPREADSHEET)
    t1 = tier1(f, CTX)
    assert tier3_reason(f, t1, proposal(0.95)) is None
    assert tier3_reason(f, t1, proposal(0.95, person=None)) is None
    assert "experiment" in tier3_reason(f, t1, proposal(0.95, experiment=P450_3))
    blob = file("/instrument/run_0042.eds", FileKind.OTHER, readable=False)
    assert tier3_reason(blob, tier1(blob, CTX), proposal(0.95)) == "unknown format"


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        label_json()[:-1],
        json.dumps({**json.loads(label_json()), "extra": 1}),
        json.dumps({k: v for k, v in json.loads(label_json()).items() if k != "reason"}),
        label_json(confidence=1.5),
        label_json(date="14/10/2026"),
        label_json(date="2026-02-30"),
        label_json(tags="dsf"),
    ],
)
def test_malformed_model_output_is_rejected(text):
    with pytest.raises(InvalidOutput):
        parse_label(text, CTX, TIER2_MODEL)


def test_parse_resolves_names_against_the_lab_and_keeps_unknown_ones_as_tags():
    p = parse_label(label_json(experiment="lysozyme", person="AB"), CTX, TIER2_MODEL)
    assert p.experiment == LYSO and p.person is not None and p.person.name == "Ama Boateng"
    p = parse_label(label_json(experiment="Zebrafish screen"), CTX, TIER2_MODEL)
    assert p.experiment is None and "zebrafish screen" in p.tags


def answers(by_path=None, *, tier3=None, caption="A gel with 10 lanes and a ladder."):
    """A fake model: captions every image; labels by file path, else a low guess."""

    def answer(request):
        if request.schema is CaptionOutput:
            return json.dumps({"kind": "gel", "description": caption, "handwriting": None})
        text = request.content[0]
        path = text.splitlines()[0].removeprefix("File: ")
        if request.model == TIER3_MODEL and tier3 is not None:
            return tier3(path)
        return (by_path or {}).get(path, label_json(clean_name="Unknown", confidence=0.3))

    return FakeModels(answer)


def lab_with_lists(conn, make_lab):
    lab = make_lab()
    for name, aliases in [("Lysozyme DSF", ["lysozyme"]), ("P450 batch 3", ["batch3"])]:
        conn.execute(
            "insert into experiments (lab_id, name, aliases) values (%s, %s, %s)",
            (lab.id, name, aliases),
        )
    conn.execute(
        "insert into people (lab_id, display_name, aliases) values (%s, 'Chen Du', '{CD}')",
        (lab.id,),
    )
    return lab


def shas(conn, lab):
    return dict(
        conn.execute("select path, sha256 from file_locations where lab_id = %s", (lab.id,))
    )


def labels(conn, lab):
    return {
        path: row
        for path, *row in conn.execute(
            "select fl.path, l.status, l.clean_name, e.name, l.source from labels l"
            " join file_locations fl on fl.lab_id = l.lab_id and fl.sha256 = l.sha256"
            " left join experiments e on e.id = l.experiment_id where l.lab_id = %s",
            (lab.id,),
        )
    }


def label_all(rt, conn, lab):
    for sha in set(shas(conn, lab).values()):
        job.label_blob(rt, lab.id, sha)


def test_without_an_api_key_files_get_rule_labels_or_wait_for_a_look(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("CD/lysozyme/2026-10-14/notes.txt", "DSF lysozyme + NAG3")
    lab.write("scratch/blob.bin", b"\x00\x01binary")
    run_scan(rt, lab.source_id)
    assert rt.models is None
    label_all(rt, conn, lab)
    got = labels(conn, lab)
    assert got["/CD/lysozyme/2026-10-14/notes.txt"] == [
        "check",
        "Lysozyme DSF notes",
        "Lysozyme DSF",
        "rules",
    ]
    assert got["/scratch/blob.bin"] == ["needs_look", None, None, "rules"]
    assert conn.execute("select count(*) from model_calls").fetchone() == (0,)


def test_a_cached_answer_is_never_paid_for_twice(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("CD/lysozyme/2026-10-14/DSF_run1.csv", "Well,Fluorescence\nA1,1\n")
    run_scan(rt, lab.source_id)
    fake = answers({"/CD/lysozyme/2026-10-14/DSF_run1.csv": label_json()})
    with_models = replace(rt, models=fake)
    label_all(with_models, conn, lab)
    assert [c.model for c in fake.calls] == [TIER2_MODEL]
    conn.execute("delete from labels where lab_id = %s", (lab.id,))
    label_all(with_models, conn, lab)
    assert len(fake.calls) == 1
    assert labels(conn, lab)["/CD/lysozyme/2026-10-14/DSF_run1.csv"][:2] == [
        "suggested",
        "Lysozyme DSF run 1",
    ]


def test_low_tier2_confidence_goes_to_tier3_whose_answer_wins(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("CD/lysozyme/2026-10-14/DSF_run1.csv", "Well,Fluorescence\nA1,1\n")
    run_scan(rt, lab.source_id)
    path = "/CD/lysozyme/2026-10-14/DSF_run1.csv"
    fake = answers(
        {path: label_json(confidence=0.6)},
        tier3=lambda _: label_json(clean_name="Lysozyme DSF run 1 (checked)", confidence=0.95),
    )
    label_all(replace(rt, models=fake), conn, lab)
    assert [c.model for c in fake.calls] == [TIER2_MODEL, TIER3_MODEL]
    assert "A faster model suggested" in fake.calls[1].content[0]
    assert labels(conn, lab)[path][:2] == ["suggested", "Lysozyme DSF run 1 (checked)"]


def test_an_image_is_captioned_once_and_found_by_what_it_shows(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("AB/IMG_4821.jpg", samples.gel_jpeg(seed=1))
    run_scan(rt, lab.source_id)
    fake = answers(caption="Coomassie gel with a strong zymogram band.")
    label_all(replace(rt, models=fake), conn, lab)
    caption_call = fake.calls[0]
    assert caption_call.schema is CaptionOutput
    assert isinstance(caption_call.content[0], Image)
    assert caption_call.content[0].media_type == "image/webp"
    assert "zymogram" in fake.calls[1].content[0]
    (kind,) = conn.execute(
        "select kind from extractions where extractor like 'caption/%%'"
    ).fetchone()
    assert kind == "image_caption"
    assert len(search(conn, lab.id, "zymogram", None)) == 1
    made = len(fake.calls)
    label_all(replace(rt, models=fake), conn, lab)
    assert len(fake.calls) == made
    assert sum(c.schema is CaptionOutput for c in fake.calls) == 1


def test_a_correction_becomes_a_rule_and_resuggests_similar_files(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    folder = "EF/screen_plate_07"
    for i in (1, 2, 3):
        lab.write(f"{folder}/plate07_read{i}.csv", f"Well,Fluorescence\nA{i},1\n")
    lab.write(f"{folder}/hits.xlsx.txt", "B4 EF-0113")
    run_scan(rt, lab.source_id)
    label_all(rt, conn, lab)
    (exp,) = conn.execute(
        "select id from experiments where lab_id = %s and name = 'P450 batch 3'", (lab.id,)
    ).fetchone()
    by_path = shas(conn, lab)
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "select * from correct_label(%s, %s, 'Plate 07 thermal shift read 1', null, %s,"
            " null, null, '{}')",
            (lab.id, by_path[f"/{folder}/plate07_read1.csv"], exp),
        )

    assert learn_pending(rt) == 0  # not settled yet; undo is still on screen
    from datetime import timedelta

    assert learn_pending(rt, settle=timedelta(0)) == 1
    rules = conn.execute(
        "select kind, folder, template from label_rules where lab_id = %s order by kind",
        (lab.id,),
    ).fetchall()
    assert rules == [
        ("folder_experiment", f"/{folder.lower()}", None),
        ("name_template", f"/{folder.lower()}", "Plate {0} thermal shift read {1}"),
    ]
    got = labels(conn, lab)
    assert got[f"/{folder}/plate07_read1.csv"][0] == "corrected"
    assert got[f"/{folder}/plate07_read3.csv"][:3] == [
        "suggested",
        "Plate 07 thermal shift read 3",
        "P450 batch 3",
    ]
    assert got[f"/{folder}/hits.xlsx.txt"][2] == "P450 batch 3"
    assert got[f"/{folder}/hits.xlsx.txt"][0] != "accepted"


def test_undoing_a_correction_retracts_its_rule(rt, conn, make_lab):
    from datetime import timedelta

    lab = lab_with_lists(conn, make_lab)
    lab.write("misc/a.txt", "notes a")
    lab.write("misc/b.txt", "notes b")
    run_scan(rt, lab.source_id)
    label_all(rt, conn, lab)
    (exp,) = conn.execute(
        "select id from experiments where lab_id = %s and name = 'Lysozyme DSF'", (lab.id,)
    ).fetchone()
    by_path = shas(conn, lab)
    with committed_as_user(conn, lab.user_id):
        (cid, _) = conn.execute(
            "select * from correct_label(%s, %s, 'Lysozyme notes', null, %s, null, null, '{}')",
            (lab.id, by_path["/misc/a.txt"], exp),
        ).fetchone()
    learn_pending(rt, settle=timedelta(0))
    assert labels(conn, lab)["/misc/b.txt"][2] == "Lysozyme DSF"
    with committed_as_user(conn, lab.user_id):
        conn.execute("select * from undo_correction(%s)", (cid,))
    learn_pending(rt, settle=timedelta(0))
    assert conn.execute("select count(*) from label_rules").fetchone() == (0,)
    assert labels(conn, lab)["/misc/b.txt"][2] is None


def test_the_worker_never_overwrites_a_persons_label(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("misc/a.txt", "notes a")
    run_scan(rt, lab.source_id)
    label_all(rt, conn, lab)
    sha = shas(conn, lab)["/misc/a.txt"]
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "select * from correct_label(%s, %s, 'Mine', null, null, null, null, '{}')",
            (lab.id, sha),
        )
    label_all(replace(rt, models=answers({"/misc/a.txt": label_json(confidence=0.99)})), conn, lab)
    assert labels(conn, lab)["/misc/a.txt"][:2] == ["corrected", "Mine"]


def test_the_lab_context_carries_corrections_as_examples(rt, conn, make_lab):
    lab = lab_with_lists(conn, make_lab)
    lab.write("misc/a.txt", "notes a")
    lab.write("misc/b.txt", "notes b")
    run_scan(rt, lab.source_id)
    label_all(rt, conn, lab)
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "select * from correct_label(%s, %s, 'Buffer prep log', null, null, null, null, '{}')",
            (lab.id, shas(conn, lab)["/misc/a.txt"]),
        )
    ctx: LabContext = job.load_context(conn, lab.id)
    assert [(e.path, e.after["clean_name"]) for e in ctx.examples] == [
        ("/misc/a.txt", "Buffer prep log")
    ]
    _ = Proposal  # the examples reach the prompt through lab_context_text
