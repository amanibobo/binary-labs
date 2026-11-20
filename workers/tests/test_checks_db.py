"""Running a lab's protocol checks against its files on local Postgres: flags raised with their
source, couldn't-check results, running again, rechecking when the checks or a label change,
the day's controls from another file, and what the database refuses."""

import uuid
from datetime import date
from pathlib import Path

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan
from psycopg.types.json import Jsonb

from bl_worker import check_runs, deletion, jobs
from bl_worker.labels import job as labels

FIXTURES = Path(__file__).parent / "fixtures" / "tables"

CURVE_ID = "0f8f2c1e-0001-4a4e-8c55-0c3c1a7a0001"
BLANK_ID = "0f8f2c1e-0002-4a4e-8c55-0c3c1a7a0002"
PEAK_ID = "0f8f2c1e-0003-4a4e-8c55-0c3c1a7a0003"
MEAN_ID = "0f8f2c1e-0004-4a4e-8c55-0c3c1a7a0004"


def curve(minimum=0.98):
    return {
        "id": CURVE_ID,
        "name": "Standard curve fit",
        "kind": "curve_fit",
        "sheet": None,
        "unit": None,
        "range": {"kind": "at_least", "min": minimum},
        "x": None,
        "y": None,
    }


def blank(maximum=0.1):
    return {
        "id": BLANK_ID,
        "name": "Blanks",
        "kind": "control",
        "sheet": None,
        "unit": "AU",
        "range": {"kind": "at_most", "max": maximum},
        "pattern": "blank",
        "labelColumn": None,
        "column": "A595",
        "use": "each",
    }


PEAK = {
    "id": PEAK_ID,
    "name": "Absorbance maximum",
    "kind": "peak",
    "sheet": None,
    "unit": "nm",
    "range": {"kind": "around", "target": 280, "tolerance": 2},
    "x": None,
    "y": None,
}

MEAN = {
    "id": MEAN_ID,
    "name": "Mean of the readings",
    "kind": "value",
    "sheet": None,
    "unit": None,
    "range": {"kind": "between", "min": 0.1, "max": 1},
    "column": "Ratio of everything",
    "stat": "mean",
    "row": None,
}


def raises_code(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


def sha_of(conn, lab, name):
    return conn.execute(
        "select sha256 from file_locations where lab_id = %s and original_name = %s",
        (lab.id, name),
    ).fetchone()[0]


def protocol(conn, lab, checks, title="Bradford assay", user=None):
    """A protocol with these checks, saved as a member; returns its id and current version."""
    with committed_as_user(conn, user or lab.user_id):
        pid, v1, _ = conn.execute(
            "select * from create_protocol(%s, 'protocol', %s, 'Read at 595 nm.')", (lab.id, title)
        ).fetchone()
        _, v2, _ = save_checks(conn, pid, v1, checks)
    return pid, v2


def save_checks(conn, pid, base, checks, note=None):
    return conn.execute(
        "select * from save_checks(%s, %s, %s, %s)", (pid, base, Jsonb(checks), note)
    ).fetchone()


def experiment(conn, lab, name, pid=None):
    with committed_as_user(conn, lab.user_id):
        return conn.execute(
            "insert into experiments (lab_id, name, protocol_id) values (%s, %s, %s) returning id",
            (lab.id, name, pid),
        ).fetchone()[0]


def label(conn, lab, sha, exp, day="2026-11-04", status="suggested", name="A file"):
    conn.execute(
        "insert into labels (lab_id, sha256, status, clean_name, date, experiment_id, confidence,"
        " source) values (%s, %s, %s, %s, %s, %s, 0.9, 'rules')",
        (lab.id, sha, status, None if status == "needs_look" else name, day, exp),
    )


def link(conn, lab, pid, sha):
    with committed_as_user(conn, lab.user_id):
        conn.execute("select link_protocol_file(%s, %s)", (pid, sha))


def run_due(rt):
    with rt.pool.connection() as c:
        todo = check_runs.due(c)
    return {sha: check_runs.run_checks(rt, lab, sha) for lab, sha in todo}


def flags_of(conn, lab, sha=None, open_only=True):
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        return cur.execute(
            "select f.*, lower(f.source_rows) as first_row, upper(f.source_rows) as end_row,"
            " f.source_rows::text as rows_text, f.control_rows::text as control_text,"
            " v.version from flags f join protocol_versions v on v.id = f.protocol_version_id"
            " where f.lab_id = %s and (%s::text is null or f.sha256 = %s)"
            " and (not %s or f.cleared_at is null) order by f.raised_at, f.id",
            (lab.id, sha, sha, open_only),
        ).fetchall()


def results_of(conn, lab, sha):
    return {
        (r[0], r[1]): r[2:]
        for r in conn.execute(
            "select check_id::text, kind::text, outcome::text, observed, reason from check_results"
            " where lab_id = %s and sha256 = %s",
            (lab.id, sha),
        )
    }


@pytest.fixture
def bench(rt, conn, make_lab):
    """A lab with the check fixtures indexed and their tables ready."""
    lab = make_lab("bench")
    for name in (
        "Bradford_2026-10-30.xlsx",
        "Bradford_2026-11-03.xlsx",
        "Bradford_2026-11-04.xlsx",
        "plate8_A595_endpoint.csv",
        "plate9_A595_endpoint.csv",
        "spectrum_BM3_2026-11-03.csv",
    ):
        lab.write(f"Data/{name}", (FIXTURES / name).read_bytes())
    run_scan(rt, lab.source_id)
    # Every ready table asks for its checks; with no protocol yet, nothing applies.
    assert set(run_due(rt).values()) == {"passed 0 flagged 0 couldnt 0"}
    return lab


def test_failing_files_get_flags_that_cite_their_source(rt, conn, bench):
    pid, version = protocol(conn, bench, [curve(), blank()])
    shas = {
        n: sha_of(conn, bench, n)
        for n in (
            "Bradford_2026-11-03.xlsx",
            "Bradford_2026-11-04.xlsx",
            "plate8_A595_endpoint.csv",
            "plate9_A595_endpoint.csv",
        )
    }
    for sha in shas.values():
        link(conn, bench, pid, sha)
    ran = run_due(rt)
    assert set(ran) == set(shas.values())

    bad_curve = flags_of(conn, bench, shas["Bradford_2026-11-04.xlsx"])
    assert len(bad_curve) == 1
    f = bad_curve[0]
    assert (f["kind"], f["observed"], f["check_id"]) == ("curve_fit", 0.8762, uuid.UUID(CURVE_ID))
    assert f["protocol_version_id"] == version and f["version"] == 2
    assert f["expected"] == {"kind": "at_least", "min": 0.98}
    assert (f["source_sheet"], f["source_columns"], f["first_row"], f["end_row"]) == (
        "Standards",
        ["A", "E"],
        0,
        6,
    )
    assert f["control_sha256"] is None and f["review"] is None

    plate = flags_of(conn, bench, shas["plate8_A595_endpoint.csv"])
    assert [(p["kind"], p["observed"]) for p in plate] == [("control", 0.225)]
    assert plate[0]["control_sha256"] == shas["plate8_A595_endpoint.csv"]
    assert (plate[0]["control_sheet"], plate[0]["control_columns"]) == ("Table 1", ["B", "C"])
    assert (plate[0]["control_text"], plate[0]["rows_text"]) == ("{[0,3)}", "{[3,15)}")
    assert plate[0]["unit"] == "AU"

    # Passing files get none; checks that don't fit a file are recorded as couldn't check.
    assert flags_of(conn, bench, shas["Bradford_2026-11-03.xlsx"]) == []
    assert flags_of(conn, bench, shas["plate9_A595_endpoint.csv"]) == []
    good = results_of(conn, bench, shas["Bradford_2026-11-03.xlsx"])
    assert good[(CURVE_ID, "curve_fit")][:2] == ("passed", 0.9998)
    assert good[(BLANK_ID, "control")][0] == "couldnt"
    # Its Samples sheet has readings in A595, but there's no blank among them.
    assert good[(BLANK_ID, "control")][2].startswith("No rows named like “blank” in this file")
    plate_results = results_of(conn, bench, shas["plate8_A595_endpoint.csv"])
    assert plate_results[(CURVE_ID, "curve_fit")][0] == "couldnt"
    assert plate_results[(BLANK_ID, "control")][:2] == ("flagged", 0.225)


def test_running_again_changes_nothing(rt, conn, bench):
    pid, _ = protocol(conn, bench, [curve(), blank()])
    for name in ("Bradford_2026-11-04.xlsx", "plate8_A595_endpoint.csv"):
        link(conn, bench, pid, sha_of(conn, bench, name))
    run_due(rt)
    before = flags_of(conn, bench, open_only=False)
    assert run_due(rt) == {}
    # Asked again with nothing changed: same flags, nothing cleared, nothing new.
    sha = sha_of(conn, bench, "Bradford_2026-11-04.xlsx")
    conn.execute(
        "update check_requests set requested_at = clock_timestamp() where sha256 = %s", (sha,)
    )
    assert run_due(rt) == {sha: "passed 0 flagged 1 couldnt 1"}
    assert flags_of(conn, bench, open_only=False) == before
    assert check_runs.run_checks(rt, bench.id, sha) is None


def test_editing_the_checks_rechecks_and_a_body_edit_keeps_them(rt, conn, bench):
    sha = sha_of(conn, bench, "Bradford_2026-11-04.xlsx")
    pid, v2 = protocol(conn, bench, [curve()])
    link(conn, bench, pid, sha)
    run_due(rt)
    [first] = flags_of(conn, bench, sha)

    # Editing the page's text carries the checks forward and leaves the flag, citing v2, alone.
    with committed_as_user(conn, bench.user_id):
        _, v3, _ = conn.execute(
            "select * from save_protocol(%s, %s, 'Bradford assay', %s, null)",
            (pid, v2, "Read at 595 nm, 10 min."),
        ).fetchone()
    (carried,) = conn.execute(
        "select expected_values from protocol_versions where id = %s", (v3,)
    ).fetchone()
    assert carried == [curve()]
    run_due(rt)
    assert [f["id"] for f in flags_of(conn, bench, sha)] == [first["id"]]

    # Loosening the range clears it; tightening raises a new one citing the new version.
    with committed_as_user(conn, bench.user_id):
        _, v4, _ = save_checks(conn, pid, v3, [curve(0.8)], "Looser while the reader is serviced")
    run_due(rt)
    assert flags_of(conn, bench, sha) == []
    [cleared] = flags_of(conn, bench, sha, open_only=False)
    assert (cleared["id"], cleared["cleared_reason"]) == (first["id"], "It passes now.")
    with committed_as_user(conn, bench.user_id):
        _, v5, n5 = save_checks(conn, pid, v4, [curve(0.9)])
    run_due(rt)
    [again] = flags_of(conn, bench, sha)
    assert (
        again["id"] != first["id"]
        and again["protocol_version_id"] == v5
        and again["version"] == n5 == 5
    )

    # Removing the check, or unlinking the file, takes the flag down with a reason.
    with committed_as_user(conn, bench.user_id):
        save_checks(conn, pid, v5, [PEAK])
    run_due(rt)
    assert flags_of(conn, bench, sha) == []
    assert flags_of(conn, bench, sha, open_only=False)[-1]["cleared_reason"] == (
        "The check no longer applies to this file."
    )
    assert results_of(conn, bench, sha) == {
        (PEAK_ID, "peak"): (
            "couldnt",
            None,
            "Couldn't tell which columns are the axis and the signal. Name them in the check.",
        )
    }


def test_a_label_ties_a_file_to_its_experiments_protocol_and_moving_it_rechecks(rt, conn, bench):
    sha = sha_of(conn, bench, "Bradford_2026-11-04.xlsx")
    pid, _ = protocol(conn, bench, [curve()])
    bradford = experiment(conn, bench, "Bradford", pid)
    other = experiment(conn, bench, "Gels")
    assert run_due(rt) == {}
    label(conn, bench, sha, bradford)
    run_due(rt)
    assert len(flags_of(conn, bench, sha)) == 1
    conn.execute(
        "update labels set experiment_id = %s where lab_id = %s and sha256 = %s",
        (other, bench.id, sha),
    )
    run_due(rt)
    assert flags_of(conn, bench, sha) == []
    # Tying the experiment to the protocol afterwards reaches its files too.
    with committed_as_user(conn, bench.user_id):
        conn.execute("update experiments set protocol_id = %s where id = %s", (pid, other))
    run_due(rt)
    assert len(flags_of(conn, bench, sha)) == 1
    # Archiving the protocol takes its flags down.
    with committed_as_user(conn, bench.user_id):
        conn.execute("select archive_protocol(%s)", (pid,))
    run_due(rt)
    assert flags_of(conn, bench, sha) == []


def test_a_needs_a_look_label_ties_nothing(rt, conn, bench):
    sha = sha_of(conn, bench, "Bradford_2026-11-04.xlsx")
    pid, _ = protocol(conn, bench, [curve()])
    exp = experiment(conn, bench, "Bradford", pid)
    label(conn, bench, sha, exp, status="needs_look")
    run_due(rt)
    assert results_of(conn, bench, sha) == {}


def test_the_days_blanks_can_come_from_another_file_of_the_same_experiment(rt, conn, make_lab):
    lab = make_lab("controls")
    lab.write("Plates/readings.csv", "Sample,A595\nLysate,0.52\nWash,0.31\nElution,0.88\n")
    lab.write("Plates/blanks.csv", "Sample,A595\nBlank 1,0.21\nBlank 2,0.05\nBlank 3,0.04\n")
    run_scan(rt, lab.source_id)
    readings, blanks = sha_of(conn, lab, "readings.csv"), sha_of(conn, lab, "blanks.csv")
    pid, _ = protocol(conn, lab, [blank()], title="Plate assay")
    exp = experiment(conn, lab, "Plates", pid)
    label(conn, lab, readings, exp)
    run_due(rt)
    assert results_of(conn, lab, readings)[(BLANK_ID, "control")][0] == "couldnt"
    # The blanks arrive labeled for the same day: the readings are checked again against them.
    label(conn, lab, blanks, exp, day=date(2026, 11, 4))
    ran = run_due(rt)
    assert readings in ran and blanks in ran
    [f] = flags_of(conn, lab, readings)
    assert (f["observed"], f["control_sha256"], f["control_text"]) == (0.21, blanks, "{[0,3)}")
    assert (f["source_sheet"], f["source_columns"], f["rows_text"]) == ("Table 1", ["B"], "{[0,3)}")
    [own] = flags_of(conn, lab, blanks)
    assert own["control_sha256"] == blanks


def test_the_jobs_run_checks_after_a_file_and_its_label(rt, conn, make_lab, monkeypatch):
    lab = make_lab("jobs")
    lab.write(
        "Bradford/Bradford_2026-11-04.xlsx", (FIXTURES / "Bradford_2026-11-04.xlsx").read_bytes()
    )
    pid, _ = protocol(conn, lab, [curve()])
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "insert into experiments (lab_id, name, protocol_id) values (%s, 'Bradford', %s)",
            (lab.id, pid),
        )
    run_scan(rt, lab.source_id)
    sha = sha_of(conn, lab, "Bradford_2026-11-04.xlsx")
    deferred = []
    monkeypatch.setattr(
        jobs, "defer_checks", lambda lab_id, s: deferred.append((lab_id, s)) or True
    )
    # The rules label it from its folder, which asks for its checks.
    labels.label_blob(rt, lab.id, sha)
    assert conn.execute(
        "select e.name from labels l join experiments e on e.id = l.experiment_id"
        " where l.sha256 = %s",
        (sha,),
    ).fetchone() == ("Bradford",)
    assert jobs.defer_checks_if_wanted(rt, lab.id, sha)
    assert deferred == [(lab.id, sha)]
    assert check_runs.due(conn) == [(lab.id, sha)]
    check_runs.run_checks(rt, lab.id, sha)
    assert len(flags_of(conn, lab, sha)) == 1
    assert not jobs.defer_checks_if_wanted(rt, lab.id, sha)


def test_a_flag_cannot_exist_without_its_version_file_and_cells(rt, conn, bench):
    sha = sha_of(conn, bench, "Bradford_2026-11-04.xlsx")
    pid, version = protocol(conn, bench, [curve(), blank()])
    good = {
        "lab_id": bench.id,
        "sha256": sha,
        "protocol_id": pid,
        "protocol_version_id": version,
        "check_id": CURVE_ID,
        "kind": "curve_fit",
        "observed": 0.5,
        "expected": Jsonb({"kind": "at_least", "min": 0.98}),
        "source_sheet": "Standards",
        "source_columns": ["A", "E"],
        "source_rows": "{[0,6)}",
        "evidence": "a" * 64,
    }

    def insert(**changes):
        row = good | changes
        cols = ", ".join(row)
        marks = ", ".join(f"%({k})s" for k in row)
        with conn.transaction():
            return conn.execute(
                f"insert into flags ({cols}) values ({marks}) returning id", row
            ).fetchone()

    with raises_code("23502"):
        insert(protocol_version_id=None)
    with raises_code("23502"):
        insert(source_rows=None)
    with raises_code("23502"):
        insert(source_columns=None)
    with raises_code("23502"):
        insert(sha256=None)
    with raises_code("23514"):
        insert(source_rows="{}")
    with raises_code("23514"):
        insert(source_columns=[])
    with raises_code("23514"):
        insert(source_columns=["A1"])
    # A value inside the range isn't a flag.
    with raises_code("23514"):
        insert(observed=0.99)
    # The cited version must hold the check, with the same range and kind.
    with raises_code("23514"):
        insert(check_id=str(uuid.uuid4()))
    with raises_code("23514"):
        insert(expected=Jsonb({"kind": "at_least", "min": 0.9}))
    (v1,) = conn.execute(
        "select based_on from protocol_versions where id = %s", (version,)
    ).fetchone()
    with raises_code("23514"):
        insert(protocol_version_id=v1)
    # A control check names the control's file and rows; nothing else does.
    with raises_code("23514"):
        insert(check_id=BLANK_ID, kind="control", observed=0.5, expected=Jsonb(blank()["range"]))
    with raises_code("23514"):
        insert(
            control_sha256=sha,
            control_sheet="Standards",
            control_columns=["A"],
            control_rows="{[0,1)}",
        )
    # A file the lab has no table for, and a version of another lab's protocol, are refused.
    with raises_code("23503"):
        insert(sha256="0" * 64)
    assert insert() is not None


def test_members_see_and_answer_only_their_labs_flags(rt, conn, bench, make_lab):
    other = make_lab("other")
    sha = sha_of(conn, bench, "Bradford_2026-11-04.xlsx")
    pid, _ = protocol(conn, bench, [curve()])
    link(conn, bench, pid, sha)
    run_due(rt)
    [flag] = flags_of(conn, bench, sha)
    with as_user(conn, other.user_id):
        for table in ("flags", "check_results", "check_requests"):
            assert conn.execute(f"select count(*) from {table}").fetchone() == (0,), table
        assert conn.execute("select count(*) from lab_flags(%s)", (bench.id,)).fetchone() == (0,)
        with raises_code("BL107"):
            conn.execute("select * from review_flag(%s, 'wrong', 'mine now')", (flag["id"],))
    with as_user(conn, other.user_id), raises_code("42501"):
        conn.execute("select * from check_usefulness(%s)", (bench.id,))
    # Only the answer can change.
    with as_user(conn, bench.user_id), raises_code("42501"):
        conn.execute("update flags set observed = 1 where id = %s", (flag["id"],))
    with committed_as_user(conn, bench.user_id):
        conn.execute(
            "select * from review_flag(%s, 'useful', '  pipetting at 750  ')", (flag["id"],)
        )
        conn.execute("select * from review_flag(%s, 'known_issue', null)", (flag["id"],))
    with as_user(conn, bench.user_id):
        row = conn.execute(
            "select review, review_note, reviewed_by from lab_flags(%s) where id = %s",
            (bench.id, flag["id"]),
        ).fetchone()
        assert row == ("known_issue", None, bench.user_id)
        assert conn.execute("select flag_queue_count(%s)", (bench.id,)).fetchone() == (0,)
        assert conn.execute("select * from check_usefulness(%s)", (bench.id,)).fetchall() == [
            (pid, uuid.UUID(CURVE_ID), 1, 0, 0, 1)
        ]
        with raises_code("22023"):
            conn.execute("update flags set review = null where id = %s", (flag["id"],))
    audit = conn.execute(
        "select actor, action::text, target from audit_log where lab_id = %s and action::text in"
        " ('flag.review', 'check.save') order by at, id",
        (bench.id,),
    ).fetchall()
    assert audit == [
        (bench.user_id, "check.save", f"{pid} v2"),
        (bench.user_id, "flag.review", f"{flag['id']} useful"),
        (bench.user_id, "flag.review", f"{flag['id']} known_issue"),
    ]


def test_checks_are_refused_when_malformed_on_tutorials_or_from_outside(conn, bench, make_lab):
    other = make_lab("other")
    with committed_as_user(conn, bench.user_id):
        pid, v1, _ = conn.execute(
            "select * from create_protocol(%s, 'protocol', 'Assay', '')", (bench.id,)
        ).fetchone()
        tid, t1, _ = conn.execute(
            "select * from create_protocol(%s, 'tutorial', 'Reader', '')", (bench.id,)
        ).fetchone()
    with as_user(conn, bench.user_id):
        for bad in (
            [curve() | {"range": {"kind": "at_least"}}],
            [curve() | {"kind": "pie"}],
            [{k: v for k, v in curve().items() if k != "x"}],
            [blank() | {"pattern": " "}],
            [MEAN | {"stat": "cell"}],
            [curve(), curve()],
            [curve() | {"range": {"kind": "between", "min": 2, "max": 1}}],
        ):
            with raises_code("23514"), conn.transaction():
                save_checks(conn, pid, v1, bad)
        with raises_code("BL108"), conn.transaction():
            save_checks(conn, tid, t1, [curve()])
        with raises_code("BL101"), conn.transaction():
            save_checks(conn, pid, v1, [curve()])
            save_checks(conn, pid, v1, [blank()])
    with as_user(conn, other.user_id), raises_code("BL103"):
        save_checks(conn, pid, v1, [curve()])
    # Members can't write the checks except through save_checks.
    with as_user(conn, bench.user_id), raises_code("42501"):
        conn.execute(
            "insert into protocol_versions (protocol_id, lab_id, based_on, title, body,"
            " expected_values) values (%s, %s, %s, 'Assay', '', '[]')",
            (pid, bench.id, v1),
        )


def test_deleting_the_lab_takes_its_flags(rt, conn, bench):
    sha = sha_of(conn, bench, "Bradford_2026-11-04.xlsx")
    pid, _ = protocol(conn, bench, [curve()])
    link(conn, bench, pid, sha)
    run_due(rt)
    with committed_as_user(conn, bench.user_id):
        conn.execute("select request_lab_deletion(%s, 'bench')", (bench.id,))
    counts = deletion.delete_lab(rt, bench.id)
    assert counts is not None
    # Every file with a table had asked to be checked.
    assert (counts["flags"], counts["check_results"], counts["check_requests"]) == (1, 1, 6)
    assert conn.execute("select count(*) from flags").fetchone() == (0,)


IC50_ID = "0f8f2c1e-0005-4a4e-8c55-0c3c1a7a0005"
BLANK_COLUMNS_ID = "0f8f2c1e-0006-4a4e-8c55-0c3c1a7a0006"

IC50 = curve() | {
    "id": IC50_ID,
    "name": "Drug A IC50",
    "range": {"kind": "between", "min": 1, "max": 2},
    "fit": "4pl",
    "measure": "midpoint",
}
BLANK_COLUMNS = blank() | {"id": BLANK_COLUMNS_ID, "by": "column", "column": None}

# The worked example's vehicle and Drug A wells, listed by well.
DOSES = (
    "Well,Drug A (µM),A570\nB2,0,1.081\nC2,0,1.094\nD2,0,1.088\n"
    "B3,100,0.198\nC3,100,0.189\nD3,100,0.225\nB4,20,0.260\nC4,20,0.282\nD4,20,0.250\n"
    "B5,4,0.511\nC5,4,0.518\nD5,4,0.490\nB6,0.8,0.907\nC6,0.8,0.933\nD6,0.8,0.925\n"
    "B7,0.16,1.066\nC7,0.16,1.089\nD7,0.16,1.073\n"
)
KINETIC = (
    "Time (s),Blank 1,Blank 2,Culture 1,Culture 2\n0,0.05,0.06,0.1,0.11\n600,0.05,0.31,0.21,0.23\n"
)


def test_an_ic50_and_blank_columns_raise_flags_with_their_cells(rt, conn, make_lab):
    lab = make_lab("curves")
    lab.write("Data/drugA_wells.csv", DOSES)
    lab.write("Data/growth_kinetic.csv", KINETIC)
    run_scan(rt, lab.source_id)
    doses, growth = sha_of(conn, lab, "drugA_wells.csv"), sha_of(conn, lab, "growth_kinetic.csv")
    pid, v2 = protocol(conn, lab, [IC50, BLANK_COLUMNS], title="Viability")
    link(conn, lab, pid, doses)
    link(conn, lab, pid, growth)
    run_due(rt)

    [ic50] = flags_of(conn, lab, doses)
    assert (ic50["kind"], ic50["observed"], ic50["unit"]) == ("curve_fit", 2.35282, "µM")
    assert (ic50["source_columns"], ic50["rows_text"]) == (["B", "C"], "{[3,18)}")
    assert results_of(conn, lab, doses)[(BLANK_COLUMNS_ID, "control")][0] == "couldnt"

    [blanks] = flags_of(conn, lab, growth)
    assert (blanks["kind"], blanks["observed"]) == ("control", 0.31)
    assert (blanks["control_columns"], blanks["control_text"]) == (["B", "C"], "{[0,2)}")
    assert (blanks["source_columns"], blanks["rows_text"]) == (["D", "E"], "{[0,2)}")

    # Loosened to take it in, the flag clears on the next run.
    looser = IC50 | {"range": {"kind": "between", "min": 1, "max": 5}}
    with committed_as_user(conn, lab.user_id):
        save_checks(conn, pid, v2, [looser, BLANK_COLUMNS])
    run_due(rt)
    assert flags_of(conn, lab, doses) == []
    assert results_of(conn, lab, doses)[(IC50_ID, "curve_fit")][:2] == ("passed", 2.35282)


def test_new_check_shapes_are_refused_when_they_contradict_themselves(conn, bench):
    with committed_as_user(conn, bench.user_id):
        pid, v1, _ = conn.execute(
            "select * from create_protocol(%s, 'protocol', 'Assay', '')", (bench.id,)
        ).fetchone()
    with as_user(conn, bench.user_id):
        for bad in (
            IC50 | {"fit": "line"},
            curve() | {"measure": "outside", "fit": "4pl"},
            curve() | {"fit": "4pl"},
            curve() | {"fit": None, "measure": None},
            curve() | {"fit": "spline", "measure": "r2"},
            BLANK_COLUMNS | {"column": "A595"},
            BLANK_COLUMNS | {"by": "cell"},
            blank() | {"by": "row", "column": None},
        ):
            with raises_code("23514"), conn.transaction():
                save_checks(conn, pid, v1, [bad])
        save_checks(conn, pid, v1, [IC50, BLANK_COLUMNS, curve() | {"id": PEAK_ID}])
