import dataclasses
import json
from pathlib import Path

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan
from psycopg.types.json import Jsonb

from bl_worker import data_tables, deletion, samples, tables

FIXTURES = Path(__file__).parent / "fixtures" / "tables"


def raises_code(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


def sha_of(conn, lab, name):
    return conn.execute(
        "select sha256 from file_locations where lab_id = %s and original_name = %s",
        (lab.id, name),
    ).fetchone()[0]


def table_row(conn, lab, sha):
    return conn.execute(
        "select state, parser_version, storage_key, error from data_tables"
        " where lab_id = %s and sha256 = %s",
        (lab.id, sha),
    ).fetchone()


SPEC = {
    "version": 1,
    "type": "scatter",
    "x": {"column": "A", "title": "BSA", "unit": "µg/mL", "min": None, "max": None},
    "y": {"title": "A595", "unit": "AU", "scale": "linear", "min": None, "max": None},
    "series": [{"column": "E", "name": "Mean", "color": "blue", "error": "F"}],
    "legend": "top",
}


def insert_chart(conn, lab, sha, spec=SPEC, protocol_id=None):
    (chart_id,) = conn.execute(
        "insert into charts (lab_id, sha256, sheet, title, spec, protocol_id)"
        " values (%s, %s, 'Standards', ' Bradford curve ', %s, %s) returning id",
        (lab.id, sha, Jsonb(spec), protocol_id),
    ).fetchone()
    return chart_id


@pytest.fixture
def charted(rt, conn, make_lab):
    lab = make_lab("charts")
    for name in ("plate7_A420.csv", "SEC_trace_141026.csv", "Bradford_2026-10-30.xlsx"):
        lab.write(f"Data/{name}", (FIXTURES / name).read_bytes())
    lab.write("Notes/readme.txt", "plate 7 rerun")
    run_scan(rt, lab.source_id)
    return lab


def test_processing_a_spreadsheet_stores_its_full_tables_once(rt, conn, charted):
    sha = sha_of(conn, charted, "Bradford_2026-10-30.xlsx")
    state, version, key, error = table_row(conn, charted, sha)
    assert (state, version, error) == ("ready", tables.VERSION, None)
    assert key == f"{charted.id}/tables/{sha}.v{tables.VERSION}.json"
    doc = json.loads(rt.previews.get(key))
    assert [t["name"] for t in doc["tables"]] == ["Standards", "Samples", "Plate"]
    for name in ("plate7_A420.csv", "SEC_trace_141026.csv"):
        assert table_row(conn, charted, sha_of(conn, charted, name))[0] == "ready"
    # Only spreadsheets get a table.
    assert table_row(conn, charted, sha_of(conn, charted, "readme.txt")) is None

    # Cached by sha256 and parser version: the same bytes aren't parsed again.
    rt.previews.put(key, b'{"marker": true}', "application/json")
    data = (FIXTURES / "Bradford_2026-10-30.xlsx").read_bytes()
    assert data_tables.build(conn, rt.previews, charted.id, sha, data) == "ready"
    assert rt.previews.get(key) == b'{"marker": true}'


def test_a_file_indexed_before_charts_is_parsed_when_someone_asks(rt, conn, charted):
    sha = sha_of(conn, charted, "plate7_A420.csv")
    conn.execute("delete from data_tables where lab_id = %s", (charted.id,))
    with committed_as_user(conn, charted.user_id):
        (state,) = conn.execute("select request_data_table(%s, %s)", (charted.id, sha)).fetchone()
    assert state == "waiting"
    assert data_tables.waiting(conn) == [(charted.id, sha)]
    assert data_tables.parse_waiting(rt, charted.id, sha) == "ready"
    assert data_tables.parse_waiting(rt, charted.id, sha) is None
    doc = json.loads(rt.previews.get(table_row(conn, charted, sha)[2]))
    assert len(doc["tables"][0]["columns"]) == 98


def test_a_failed_table_can_be_asked_for_again(rt, conn, charted):
    sha = sha_of(conn, charted, "plate7_A420.csv")
    assert data_tables.build(conn, rt.previews, charted.id, sha, b"PK\x03\x04junk") == "ready"
    conn.execute("delete from data_tables where lab_id = %s and sha256 = %s", (charted.id, sha))
    assert data_tables.build(conn, rt.previews, charted.id, sha, b"PK\x03\x04junk") == "failed"
    state, _, key, error = table_row(conn, charted, sha)
    assert (state, key) == ("failed", None) and error.startswith("We couldn't read a table")
    with committed_as_user(conn, charted.user_id):
        conn.execute("select request_data_table(%s, %s)", (charted.id, sha))
    assert table_row(conn, charted, sha)[0] == "waiting"
    # The worker reads the real bytes again.
    assert data_tables.parse_waiting(rt, charted.id, sha) == "ready"


def test_asking_for_a_table_needs_a_member_and_a_spreadsheet(conn, charted, make_lab):
    other = make_lab("other")
    sha = sha_of(conn, charted, "plate7_A420.csv")
    with as_user(conn, other.user_id), raises_code("42501"):
        conn.execute("select request_data_table(%s, %s)", (charted.id, sha))
    text = sha_of(conn, charted, "readme.txt")
    with as_user(conn, charted.user_id), raises_code("BL104"):
        conn.execute("select request_data_table(%s, %s)", (charted.id, text))


def test_charts_stay_inside_their_lab(conn, charted, make_lab):
    other = make_lab("other")
    other.write("x.csv", samples.csv_text([["t", "v"], [0, 1], [1, 2]]))
    sha = sha_of(conn, charted, "Bradford_2026-10-30.xlsx")
    with committed_as_user(conn, charted.user_id):
        chart_id = insert_chart(conn, charted, sha)
    with as_user(conn, other.user_id):
        assert conn.execute("select count(*) from charts").fetchone() == (0,)
        assert conn.execute("select count(*) from data_tables").fetchone() == (0,)
        assert (
            conn.execute("update charts set title = 'mine now' where id = %s", (chart_id,)).rowcount
            == 0
        )
        assert conn.execute("delete from charts where id = %s", (chart_id,)).rowcount == 0
    with as_user(conn, other.user_id), raises_code("42501"):
        insert_chart(conn, charted, sha)
    # A lab can only chart a file it holds.
    with as_user(conn, other.user_id), raises_code("BL104"):
        insert_chart(conn, other, sha)


def test_a_bad_spec_is_refused_by_the_database(conn, charted):
    sha = sha_of(conn, charted, "Bradford_2026-10-30.xlsx")
    bad = [
        {**SPEC, "type": "pie"},
        {**SPEC, "x": {**SPEC["x"], "column": "A1"}},
        {**SPEC, "series": []},
        {**SPEC, "series": [{**SPEC["series"][0], "color": "#ff0000"}]},
        {**SPEC, "series": [{**SPEC["series"][0], "name": "  "}]},
        {**SPEC, "series": [{**SPEC["series"][0], "column": None}]},
        {**SPEC, "type": "bar", "y": {**SPEC["y"], "scale": "log"}},
        {**SPEC, "series": [SPEC["series"][0]] * 4},
        {k: v for k, v in SPEC.items() if k != "legend"},
    ]
    for spec in bad:
        with as_user(conn, charted.user_id), raises_code("23514"):
            insert_chart(conn, charted, sha, spec)


def test_saving_keeps_who_made_it_and_audits_every_change(conn, charted):
    sha = sha_of(conn, charted, "Bradford_2026-10-30.xlsx")
    with committed_as_user(conn, charted.user_id):
        chart_id = insert_chart(conn, charted, sha)
        conn.execute("update charts set title = 'Standard curve' where id = %s", (chart_id,))
    for column in ("created_by", "sha256", "lab_id"):
        with as_user(conn, charted.user_id), raises_code("42501"):
            conn.execute(f"update charts set {column} = null where id = %s", (chart_id,))
    with as_user(conn, charted.user_id):
        conn.execute("delete from charts where id = %s", (chart_id,))
    title, made_by, kept_sha = conn.execute(
        "select title, created_by, sha256 from charts where id = %s", (chart_id,)
    ).fetchone()
    assert (title, made_by, kept_sha) == ("Standard curve", charted.user_id, sha)
    actions = conn.execute(
        "select action::text, actor from audit_log where target = %s order by id", (str(chart_id),)
    ).fetchall()
    assert actions == [("chart.create", charted.user_id), ("chart.save", charted.user_id)]


def test_a_chart_links_only_to_a_live_protocol_of_its_lab(conn, charted, make_lab):
    other = make_lab("other")
    sha = sha_of(conn, charted, "Bradford_2026-10-30.xlsx")
    with committed_as_user(conn, other.user_id):
        (theirs,) = conn.execute(
            "select protocol_id from create_protocol(%s, 'protocol', 'Theirs', '1. x')", (other.id,)
        ).fetchone()
    with committed_as_user(conn, charted.user_id):
        (mine,) = conn.execute(
            "select protocol_id from create_protocol(%s, 'protocol', 'Bradford', '1. x')",
            (charted.id,),
        ).fetchone()
        chart_id = insert_chart(conn, charted, sha, protocol_id=mine)
    with as_user(conn, charted.user_id), raises_code("BL103"):
        conn.execute("update charts set protocol_id = %s where id = %s", (theirs, chart_id))
    conn.execute("update protocols set archived_at = now() where id = %s", (mine,))
    with as_user(conn, charted.user_id), raises_code("BL102"):
        insert_chart(conn, charted, sha, protocol_id=mine)
    # Already linked before it was archived: saving the chart again still works.
    with as_user(conn, charted.user_id):
        conn.execute("update charts set title = 'Again' where id = %s", (chart_id,))


def test_deleting_the_lab_removes_its_charts_and_tables(rt, conn, charted):
    sha = sha_of(conn, charted, "Bradford_2026-10-30.xlsx")
    with committed_as_user(conn, charted.user_id):
        insert_chart(conn, charted, sha)
        conn.execute("select request_lab_deletion(%s, %s)", (charted.id, "charts"))
    counts = deletion.delete_lab(rt, charted.id)
    assert counts is not None
    assert counts["charts"] == 1 and counts["data_tables"] == 3
    assert rt.previews.get(data_tables.table_key(charted.id, sha)) is None
    assert conn.execute("select count(*) from blobs where sha256 = %s", (sha,)).fetchone() == (0,)


COLORS = ["blue", "orange", "aqua", "violet", "magenta", "green"]
TWELVE = [
    {
        "column": c,
        "name": c,
        "color": COLORS[i % 6],
        "error": None,
        "stroke": "dashed" if i >= 6 else "solid",
    }
    for i, c in enumerate("BCDEFGHIJKLM")
]
PLATE = {
    "version": 1,
    "type": "heatmap",
    "plate": {"size": 96, "source": {"kind": "wells", "well": "A", "value": "C"}},
    "value": {"title": "OD450", "unit": "", "min": None, "max": None},
}


def test_the_database_takes_what_charts_draw_now(conn, charted):
    sha = sha_of(conn, charted, "SEC_trace_141026.csv")
    good = [
        {**SPEC, "type": "line", "series": TWELVE},
        {**SPEC, "type": "line", "series": [{**SPEC["series"][0], "x": "E"}]},
        {**SPEC, "series": [{**SPEC["series"][0], "x": None, "stroke": "solid"}]},
        PLATE,
        {**PLATE, "plate": {"size": 384, "source": {"kind": "grid", "rows": "A"}}},
        {**PLATE, "plate": {"size": 96, "source": {"kind": "read", "row": 30}}},
    ]
    for spec in good:
        with as_user(conn, charted.user_id):
            insert_chart(conn, charted, sha, spec)
    bad = [
        {**SPEC, "type": "line", "series": [*TWELVE, {**TWELVE[0], "column": "N"}]},
        {**SPEC, "type": "bar", "series": [{**s, "stroke": "solid"} for s in TWELVE[:7]]},
        {**SPEC, "series": [{**SPEC["series"][0], "stroke": "dashed"}]},
        {**SPEC, "type": "bar", "series": [{**SPEC["series"][0], "x": "B"}]},
        {**SPEC, "type": "line", "series": [{**SPEC["series"][0], "x": "B1"}]},
        {**PLATE, "plate": {"size": 48, "source": PLATE["plate"]["source"]}},
        {**PLATE, "plate": {"size": 96, "source": {"kind": "read", "row": -1}}},
        {**PLATE, "plate": {"size": 96, "source": {"kind": "read", "row": 1.5}}},
        {**PLATE, "plate": {"size": 96, "source": {"kind": "read", "row": "3"}}},
        {**PLATE, "plate": {"size": 96, "source": {"kind": "wells", "well": "A"}}},
        {k: v for k, v in PLATE.items() if k != "value"},
    ]
    for spec in bad:
        with as_user(conn, charted.user_id), raises_code("23514"):
            insert_chart(conn, charted, sha, spec)


OLD = b'{"version":1,"cellLimit":200000,"tables":[]}'


def made_by_an_older_parser(rt, conn, lab, sha, *, asked_days_ago=0):
    """Puts a table back the way parser version 1 left it: at its old key, at version 1."""
    old_key = data_tables.table_key(lab.id, sha, 1)
    rt.previews.put(old_key, OLD, "application/json")
    rt.previews.delete_prefix(data_tables.table_key(lab.id, sha))
    conn.execute(
        "update data_tables set parser_version = 1, storage_key = %s,"
        " requested_at = now() - make_interval(days => %s)"
        " where lab_id = %s and sha256 = %s",
        (old_key, asked_days_ago, lab.id, sha),
    )
    return old_key


def test_a_parser_bump_re_parses_stored_tables_oldest_used_first(rt, conn, charted):
    plate = sha_of(conn, charted, "plate7_A420.csv")
    sec = sha_of(conn, charted, "SEC_trace_141026.csv")
    bradford = sha_of(conn, charted, "Bradford_2026-10-30.xlsx")
    made_by_an_older_parser(rt, conn, charted, plate, asked_days_ago=30)
    old_sec = made_by_an_older_parser(rt, conn, charted, sec, asked_days_ago=20)
    made_by_an_older_parser(rt, conn, charted, bradford, asked_days_ago=40)
    # A chart saved today makes the Bradford workbook the most recently used.
    with committed_as_user(conn, charted.user_id):
        chart_id = insert_chart(conn, charted, bradford)
    stale = [(charted.id, plate), (charted.id, sec), (charted.id, bradford)]
    assert data_tables.stale(conn) == stale
    assert data_tables.stale(conn, limit=1) == stale[:1]
    assert str(data_tables.progress(conn)) == f"0 at v{tables.VERSION}, 3 to go, 0 kept old"

    # Until the new table is stored, readers get the old one.
    assert rt.previews.get(old_sec) == OLD
    assert data_tables.reparse(rt, charted.id, sec) == "ready"
    state, version, key, _ = table_row(conn, charted, sec)
    assert (state, version) == ("ready", tables.VERSION)
    assert key == data_tables.table_key(charted.id, sec)
    assert json.loads(rt.previews.get(key))["version"] == tables.VERSION
    assert rt.previews.get(old_sec) is None
    # Idempotent: done is done, and stopping part way leaves the rest for the next sweep.
    assert data_tables.reparse(rt, charted.id, sec) is None
    assert data_tables.stale(conn) == [stale[0], stale[2]]

    for lab_id, sha in data_tables.stale(conn):
        assert data_tables.reparse(rt, lab_id, sha) == "ready"
    assert data_tables.stale(conn) == []
    assert str(data_tables.progress(conn)) == f"3 at v{tables.VERSION}, 0 to go, 0 kept old"
    # The sweep never touches a chart.
    row = conn.execute("select title, spec from charts where id = %s", (chart_id,)).fetchone()
    assert row == ("Bradford curve", SPEC)


def test_a_re_parse_that_fails_keeps_the_old_table_and_says_why(rt, conn, charted, monkeypatch):
    sha = sha_of(conn, charted, "SEC_trace_141026.csv")
    old_key = made_by_an_older_parser(rt, conn, charted, sha)

    def refuse(data):
        raise tables.TableFailed("not a table any more")

    monkeypatch.setattr(tables, "parse", refuse)
    assert data_tables.reparse(rt, charted.id, sha) == "kept"
    assert table_row(conn, charted, sha) == ("ready", 1, old_key, None)
    assert rt.previews.get(old_key) == OLD
    assert conn.execute(
        "select reparse_version, reparse_error from data_tables where lab_id = %s and sha256 = %s",
        (charted.id, sha),
    ).fetchone() == (tables.VERSION, "not a table any more")
    # Tried once per version: the sweep moves on, and the row counts as kept.
    assert (charted.id, sha) not in data_tables.stale(conn)
    assert data_tables.reparse(rt, charted.id, sha) is None
    assert data_tables.progress(conn).kept == 1


def test_a_file_that_cant_be_read_keeps_its_old_table(rt, conn, charted):
    sha = sha_of(conn, charted, "plate7_A420.csv")
    old_key = made_by_an_older_parser(rt, conn, charted, sha)
    conn.execute(
        "update file_locations set deleted_at = now() where lab_id = %s and sha256 = %s",
        (charted.id, sha),
    )
    assert data_tables.reparse(rt, charted.id, sha) == "kept"
    assert table_row(conn, charted, sha)[:3] == ("ready", 1, old_key)


def test_a_re_parse_that_drops_a_column_leaves_the_chart_for_a_person_to_fix(
    rt, conn, charted, monkeypatch
):
    sha = sha_of(conn, charted, "Bradford_2026-10-30.xlsx")
    with committed_as_user(conn, charted.user_id):
        chart_id = insert_chart(conn, charted, sha)
    made_by_an_older_parser(rt, conn, charted, sha)
    real = tables.parse

    def without_sd(data):
        parsed = real(data)
        first = parsed.tables[0]
        kept = [c for c in first.columns if c.id != "F"]
        return tables.Parsed([dataclasses.replace(first, columns=kept), *parsed.tables[1:]])

    monkeypatch.setattr(tables, "parse", without_sd)
    assert data_tables.reparse(rt, charted.id, sha) == "ready"
    doc = json.loads(rt.previews.get(table_row(conn, charted, sha)[2]))
    assert "F" not in [c["id"] for c in doc["tables"][0]["columns"]]
    # The chart still names F; the web app says it went and offers to fix it.
    spec = conn.execute("select spec from charts where id = %s", (chart_id,)).fetchone()[0]
    assert spec["series"][0]["error"] == "F"
