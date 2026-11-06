"""The lab calendar (migration 0017): plans members write, and the record worked out per day
from dates the lab already has. Rows are written as the table owner where the worker or another
feature would write them, and read as members with RLS on."""

import hashlib
import time
import uuid
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg
import pytest
from conftest import as_user, committed_as_user
from psycopg.types.json import Jsonb

from bl_worker import deletion

NY = "America/New_York"
SPEC = {
    "version": 1,
    "type": "line",
    "x": {"column": "A", "title": "t", "unit": None, "min": None, "max": None},
    "y": {"title": "v", "unit": None, "scale": "linear", "min": None, "max": None},
    "series": [{"column": "B", "name": "v", "color": "blue", "error": None}],
    "legend": "top",
}


def raises_code(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


def ny(*args) -> datetime:
    return datetime(*args, tzinfo=ZoneInfo(NY))


def sha(seed: str) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()


def add_member(conn, lab_id, role="member"):
    user_id = uuid.uuid4()
    conn.execute("insert into auth.users (id) values (%s)", (user_id,))
    conn.execute(
        "insert into members (lab_id, user_id, role) values (%s, %s, %s)", (lab_id, user_id, role)
    )
    return user_id


def add_source(conn, lab_id, kind):
    (source_id,) = conn.execute(
        "insert into sources (lab_id, kind, root_path) values (%s, %s, '/') returning id",
        (lab_id, kind),
    ).fetchone()
    return source_id


def add_instrument(conn, lab_id, name):
    source_id = add_source(conn, lab_id, "instrument")
    (instrument_id,) = conn.execute(
        "insert into instruments (lab_id, source_id, name) values (%s, %s, %s) returning id",
        (lab_id, source_id, name),
    ).fetchone()
    return instrument_id, source_id


def add_file(conn, lab_id, source_id, name, modified_at, *, seed=None, label=None, kind="pdf"):
    """A processed file as the worker leaves it, with an optional label: (date, experiment,
    person, instrument)."""
    digest = sha(seed or f"{lab_id}{name}")
    conn.execute(
        "insert into blobs (sha256, size, mime, file_kind) values (%s, 1, 'application/pdf', %s)"
        " on conflict do nothing",
        (digest, kind),
    )
    (location_id,) = conn.execute(
        "insert into file_locations (lab_id, source_id, external_id, path, original_name, size,"
        " modified_at, source_rev, sha256, index_state) values"
        " (%s, %s, %s, %s, %s, 1, %s, 'r', %s, 'indexed') returning id",
        (lab_id, source_id, f"{name}-{uuid.uuid4()}", f"/{name}", name, modified_at, digest),
    ).fetchone()
    if label is not None:
        day, experiment, person, instrument = label
        conn.execute(
            "insert into labels (lab_id, sha256, status, clean_name, date, experiment_id,"
            " person_id, instrument, confidence, source) values"
            " (%s, %s, 'accepted', %s, %s, %s, %s, %s, 0.9, 'test')"
            " on conflict (lab_id, sha256) do nothing",
            (lab_id, digest, f"Clean {name}", day, experiment, person, instrument),
        )
    return digest, location_id


def add_experiment(conn, lab_id, name, protocol_id=None):
    (experiment_id,) = conn.execute(
        "insert into experiments (lab_id, name, protocol_id) values (%s, %s, %s) returning id",
        (lab_id, name, protocol_id),
    ).fetchone()
    return experiment_id


def add_person(conn, lab_id, name, user_id=None):
    (person_id,) = conn.execute(
        "insert into people (lab_id, display_name, member_user_id) values (%s, %s, %s)"
        " returning id",
        (lab_id, name, user_id),
    ).fetchone()
    return person_id


def make_protocol(conn, lab, title):
    with committed_as_user(conn, lab.user_id):
        (protocol_id,) = conn.execute(
            "select protocol_id from create_protocol(%s, 'protocol', %s, '1. Spin.')",
            (lab.id, title),
        ).fetchone()
    return protocol_id


def insert_entry(conn, lab_id, title="Plate reads", **fields):
    columns = ["lab_id", "title", *fields]
    values = [lab_id, title, *fields.values()]
    (entry_id,) = conn.execute(
        f"insert into calendar_entries ({', '.join(columns)}) values"
        f" ({', '.join(['%s'] * len(values))}) returning id",
        values,
    ).fetchone()
    return entry_id


def timed(start: datetime, hours: float = 1):
    """Elapsed hours: aware datetimes in Python add wall-clock time within their zone."""
    start = start.astimezone(UTC)
    return {"starts_at": start, "ends_at": start + timedelta(hours=hours)}


def record(conn, user_id, lab_id, start, end, tz=NY, **filters):
    with as_user(conn, user_id):
        return conn.execute(
            "select day, kind, group_name, items, title"
            " from calendar_record(%s, %s, %s, %s, %s, %s, %s)",
            (
                lab_id,
                start,
                end,
                tz,
                filters.get("experiment"),
                filters.get("person"),
                filters.get("instrument"),
            ),
        ).fetchall()


def plans(conn, user_id, lab_id, start, end, tz=NY, **filters):
    with as_user(conn, user_id):
        return [
            r[0]
            for r in conn.execute(
                "select * from calendar_plans(%s, %s, %s, %s, %s, %s, %s)",
                (
                    lab_id,
                    start,
                    end,
                    tz,
                    filters.get("experiment"),
                    filters.get("person"),
                    filters.get("instrument"),
                ),
            )
        ]


def test_one_labs_calendar_is_invisible_and_closed_to_another(conn, make_lab):
    a, b = make_lab("alpha"), make_lab("bravo")
    with committed_as_user(conn, a.user_id):
        entry = insert_entry(conn, a.id, starts_on=date(2026, 11, 5), ends_on=date(2026, 11, 5))
    with as_user(conn, b.user_id):
        assert conn.execute("select count(*) from calendar_entries").fetchone() == (0,)
        assert (
            conn.execute(
                "update calendar_entries set title = 'mine' where id = %s", (entry,)
            ).rowcount
            == 0
        )
        assert conn.execute("delete from calendar_entries where id = %s", (entry,)).rowcount == 0
        assert conn.execute("select calendar_entry(%s)", (entry,)).fetchone() == (None,)
    assert plans(conn, b.user_id, a.id, date(2026, 11, 1), date(2026, 11, 30)) == []
    assert len(plans(conn, a.user_id, a.id, date(2026, 11, 1), date(2026, 11, 30))) == 1
    with as_user(conn, b.user_id), raises_code("42501"):
        insert_entry(conn, a.id, starts_on=date(2026, 11, 5), ends_on=date(2026, 11, 5))
    with as_user(conn, b.user_id), raises_code("42501"):
        conn.execute(
            "select * from calendar_record(%s, '2026-11-01', '2026-11-30', %s)", (a.id, NY)
        )
    # Members can't set who made it or move it to another lab.
    for column in ("created_by", "lab_id", "created_at"):
        with as_user(conn, a.user_id), raises_code("42501"):
            conn.execute(f"update calendar_entries set {column} = null where id = %s", (entry,))


def test_an_entry_is_dates_or_instants_never_both(conn, make_lab):
    lab = make_lab()
    bad = [
        {},
        {"starts_on": date(2026, 11, 5)},
        {"starts_on": date(2026, 11, 5), "ends_on": date(2026, 11, 4)},
        {**timed(ny(2026, 11, 5, 9)), "starts_on": date(2026, 11, 5), "ends_on": date(2026, 11, 5)},
        {"starts_at": ny(2026, 11, 5, 9), "ends_at": ny(2026, 11, 5, 9)},
        timed(ny(2026, 11, 5, 9), hours=24 * 40),
    ]
    for fields in bad:
        with as_user(conn, lab.user_id), raises_code("23514"):
            insert_entry(conn, lab.id, **fields)
    with as_user(conn, lab.user_id), raises_code("23514"):
        insert_entry(
            conn, lab.id, title="  ", starts_on=date(2026, 11, 5), ends_on=date(2026, 11, 5)
        )


def test_links_stay_inside_the_lab_and_refuse_archived_or_removed_things(conn, make_lab):
    lab, other = make_lab("alpha"), make_lab("other")
    mine = make_protocol(conn, lab, "Bradford")
    theirs = make_protocol(conn, other, "Theirs")
    exp_theirs = add_experiment(conn, other.id, "Their experiment")
    person_theirs = add_person(conn, other.id, "Their person")
    inst_theirs, _ = add_instrument(conn, other.id, "Their reader")
    inst_mine, _ = add_instrument(conn, lab.id, "SpectraMax")
    day = {"starts_on": date(2026, 11, 5), "ends_on": date(2026, 11, 5)}
    for code, link in [
        ("BL103", {"protocol_id": theirs}),
        ("BL401", {"experiment_id": exp_theirs}),
        ("BL401", {"instrument_id": inst_theirs}),
        ("BL401", {"person_ids": [person_theirs]}),
    ]:
        with as_user(conn, lab.user_id), raises_code(code):
            insert_entry(conn, lab.id, **day, **link)

    with committed_as_user(conn, lab.user_id):
        entry = insert_entry(conn, lab.id, **day, protocol_id=mine, instrument_id=inst_mine)
    conn.execute("update protocols set archived_at = now() where id = %s", (mine,))
    conn.execute("update instruments set revoked_at = now() where id = %s", (inst_mine,))
    with as_user(conn, lab.user_id), raises_code("BL102"):
        insert_entry(conn, lab.id, **day, protocol_id=mine)
    with as_user(conn, lab.user_id), raises_code("BL402"):
        insert_entry(conn, lab.id, **day, instrument_id=inst_mine)
    # Linked before: saving the entry again keeps both and still works.
    with as_user(conn, lab.user_id):
        conn.execute("update calendar_entries set title = 'Again' where id = %s", (entry,))
        (json,) = conn.execute("select calendar_entry(%s)", (entry,)).fetchone()
    assert json["protocol"]["archived"] is True and json["instrument"]["revoked"] is True


def test_people_are_kept_once_in_order_and_a_removed_person_drops_out(conn, make_lab):
    lab = make_lab()
    rosa, sam = add_person(conn, lab.id, "Rosa"), add_person(conn, lab.id, "Sam")
    with committed_as_user(conn, lab.user_id):
        entry = insert_entry(
            conn,
            lab.id,
            starts_on=date(2026, 11, 5),
            ends_on=date(2026, 11, 5),
            person_ids=[sam, rosa, sam],
        )
        (json,) = conn.execute("select calendar_entry(%s)", (entry,)).fetchone()
    assert [p["name"] for p in json["people"]] == ["Sam", "Rosa"]
    conn.execute("delete from people where id = %s", (sam,))
    with as_user(conn, lab.user_id):
        (json,) = conn.execute("select calendar_entry(%s)", (entry,)).fetchone()
        assert [p["name"] for p in json["people"]] == ["Rosa"]
        conn.execute("update calendar_entries set notes = '  ' where id = %s", (entry,))
        stored = conn.execute(
            "select person_ids, notes from calendar_entries where id = %s", (entry,)
        ).fetchone()
    assert stored == ([rosa], None)


def test_every_change_is_audited_with_who_made_it(rt, conn, make_lab):
    lab = make_lab("audited")
    member = add_member(conn, lab.id)
    with committed_as_user(conn, member):
        entry = insert_entry(conn, lab.id, title=" Gel run ", **timed(ny(2026, 11, 5, 9)))
    with committed_as_user(conn, lab.user_id):
        conn.execute("update calendar_entries set title = 'Gel run 2' where id = %s", (entry,))
        conn.execute("delete from calendar_entries where id = %s", (entry,))
    actions = conn.execute(
        "select action::text, actor from audit_log where target = %s order by id", (str(entry),)
    ).fetchall()
    assert actions == [
        ("calendar.create", member),
        ("calendar.save", lab.user_id),
        ("calendar.delete", lab.user_id),
    ]

    with committed_as_user(conn, lab.user_id):
        insert_entry(conn, lab.id, starts_on=date(2026, 11, 6), ends_on=date(2026, 11, 6))
        conn.execute("select request_lab_deletion(%s, 'audited')", (lab.id,))
    counts = deletion.delete_lab(rt, lab.id)
    assert counts is not None and counts["calendar_entries"] == 1
    assert conn.execute("select count(*) from calendar_entries").fetchone() == (0,)


@pytest.fixture
def busy(conn, make_lab):
    """A lab's first week of November 2026 in New York, where the clocks went back on Sunday
    the 1st: labeled files, files dated only by when they were saved, uploads, an instrument's
    files, a talk-through, protocol versions and a chart."""
    lab = make_lab("busy")
    rosa = add_member(conn, lab.id)
    rosa_person = add_person(conn, lab.id, "Rosa", rosa)
    sam_person = add_person(conn, lab.id, "Sam")
    protocol = make_protocol(conn, lab, "Bradford assay")
    p450 = add_experiment(conn, lab.id, "P450 BM3", protocol)
    sec = add_experiment(conn, lab.id, "SEC")
    reader, reader_source = add_instrument(conn, lab.id, "SpectraMax")
    upload_source = add_source(conn, lab.id, "upload")
    tue = date(2026, 11, 3)
    for i in range(12):
        add_file(
            conn,
            lab.id,
            lab.source_id,
            f"gel{i}.pdf",
            ny(2026, 10, 1),
            label=(tue, p450, sam_person, None),
        )
    for i in range(3):
        add_file(
            conn,
            lab.id,
            lab.source_id,
            f"sec{i}.pdf",
            ny(2026, 10, 1),
            label=(tue, sec, None, None),
        )
    add_file(
        conn, lab.id, lab.source_id, "loose.pdf", ny(2026, 10, 1), label=(tue, None, None, None)
    )
    # Saved at 9 pm on Wednesday in New York, which is already Thursday in UTC.
    late, _ = add_file(conn, lab.id, lab.source_id, "late.pdf", ny(2026, 11, 4, 21))
    # The same bytes in two places are one file, dated by its newest copy.
    add_file(conn, lab.id, lab.source_id, "dup-a.pdf", ny(2026, 11, 2, 10), seed="dup")
    add_file(conn, lab.id, lab.source_id, "dup-b.pdf", ny(2026, 11, 5, 10), seed="dup")
    # A file removed from Dropbox isn't on the record.
    _, gone = add_file(conn, lab.id, lab.source_id, "gone.pdf", ny(2026, 11, 5, 11))
    conn.execute("update file_locations set deleted_at = now() where id = %s", (gone,))
    for i in range(2):
        add_file(
            conn,
            lab.id,
            upload_source,
            f"photo{i}.jpg",
            ny(2026, 11, 5, 9),
            label=(date(2026, 11, 5), p450, rosa_person, None),
        )
    for i in range(4):
        add_file(
            conn,
            lab.id,
            reader_source,
            f"read{i}.csv",
            ny(2026, 11, 5, 9),
            label=(date(2026, 11, 5), sec, None, "SpectraMax"),
        )
    # Read on another PC but labeled with the reader's name.
    add_file(
        conn,
        lab.id,
        lab.source_id,
        "named.csv",
        ny(2026, 10, 1),
        label=(date(2026, 11, 6), None, None, "spectramax"),
    )
    _, recording = add_file(
        conn, lab.id, upload_source, "talk.weba", ny(2026, 11, 2, 14), kind="other"
    )
    conn.execute(
        "insert into talk_throughs (lab_id, location_id, kind, protocol_id, base_version_id,"
        " recorded_by, recorded_at) select %s, %s, 'protocol', p.id, p.current_version_id, %s, %s"
        " from protocols p where p.id = %s",
        (lab.id, recording, rosa, ny(2026, 11, 2, 14), protocol),
    )
    conn.execute(
        "update protocol_versions set created_at = %s where protocol_id = %s",
        (ny(2026, 11, 1, 1, 30), protocol),
    )
    with committed_as_user(conn, rosa):
        conn.execute(
            "select save_protocol(%s, (select current_version_id from protocols where id = %s),"
            " 'Bradford assay', '1. Spin twice.')",
            (protocol, protocol),
        )
    conn.execute(
        "update protocol_versions set created_at = %s where protocol_id = %s and version = 2",
        (ny(2026, 11, 1, 1, 45), protocol),
    )
    chart_sha, _ = add_file(
        conn,
        lab.id,
        lab.source_id,
        "plate.csv",
        ny(2026, 9, 1),
        kind="spreadsheet",
        label=(date(2026, 9, 1), p450, None, None),
    )
    with committed_as_user(conn, lab.user_id):
        conn.execute(
            "insert into charts (lab_id, sha256, sheet, title, spec)"
            " values (%s, %s, 'Table 1', 'Plate 7', %s)",
            (lab.id, chart_sha, Jsonb(SPEC)),
        )
    # Its trigger keeps created_at; a chart made last week is set as the owner, triggers off.
    with conn.transaction():
        conn.execute("set local session_replication_role = replica")
        conn.execute(
            "update charts set created_at = %s where lab_id = %s", (ny(2026, 11, 6, 16), lab.id)
        )
    return {
        "lab": lab,
        "rosa": rosa,
        "rosa_person": rosa_person,
        "sam_person": sam_person,
        "p450": p450,
        "sec": sec,
        "reader": reader,
        "late": late,
    }


WEEK = (date(2026, 11, 1), date(2026, 11, 7))


def test_the_record_counts_each_day_by_kind_and_experiment(conn, busy):
    lab = busy["lab"]
    rows = record(conn, lab.user_id, lab.id, *WEEK)
    assert rows == [
        # Both versions were saved in the hour the clocks went back.
        (date(2026, 11, 1), "protocol", "Bradford assay", 2, None),
        (date(2026, 11, 2), "talk_through", None, 1, "Bradford assay"),
        (date(2026, 11, 3), "file", "P450 BM3", 12, None),
        (date(2026, 11, 3), "file", "SEC", 3, None),
        (date(2026, 11, 3), "file", None, 1, "Clean loose.pdf"),
        (date(2026, 11, 4), "file", None, 1, "late.pdf"),
        (date(2026, 11, 5), "file", None, 1, "dup-b.pdf"),
        (date(2026, 11, 5), "upload", "P450 BM3", 2, None),
        (date(2026, 11, 5), "instrument", "SpectraMax", 4, None),
        (date(2026, 11, 6), "file", None, 1, "Clean named.csv"),
        (date(2026, 11, 6), "chart", None, 1, "Plate 7"),
    ]
    # In UTC the late file is on Thursday, and both protocol saves on Sunday at 5 and 6 am.
    utc = record(conn, lab.user_id, lab.id, *WEEK, tz="UTC")
    assert (date(2026, 11, 5), "file", None, 2, None) in utc
    assert (date(2026, 11, 1), "protocol", "Bradford assay", 2, None) in utc


def test_the_record_filters_by_experiment_person_and_instrument(conn, busy):
    lab = busy["lab"]
    by_p450 = record(conn, lab.user_id, lab.id, *WEEK, experiment=busy["p450"])
    assert [(r[1], r[3]) for r in by_p450] == [
        # The experiment's protocol brings its saves and its talk-through along.
        ("protocol", 2),
        ("talk_through", 1),
        ("file", 12),
        ("upload", 2),
        # The chart's file is labeled P450 BM3.
        ("chart", 1),
    ]
    by_rosa = record(conn, lab.user_id, lab.id, *WEEK, person=busy["rosa_person"])
    assert [(r[0].day, r[1], r[3]) for r in by_rosa] == [
        (1, "protocol", 1),
        (2, "talk_through", 1),
        (5, "upload", 2),
    ]
    # Sam has no membership, so only files labeled with him count.
    by_sam = record(conn, lab.user_id, lab.id, *WEEK, person=busy["sam_person"])
    assert [(r[1], r[3]) for r in by_sam] == [("file", 12)]
    by_reader = record(conn, lab.user_id, lab.id, *WEEK, instrument=busy["reader"])
    assert [(r[0].day, r[1], r[3]) for r in by_reader] == [(5, "instrument", 4), (6, "file", 1)]


def test_a_day_lists_its_files_and_events(conn, busy):
    lab = busy["lab"]
    with as_user(conn, lab.user_id):
        files = conn.execute(
            "select name from calendar_files(%s, '2026-11-03', '2026-11-03', %s)"
            " where group_id = %s order by name limit 5",
            (lab.id, NY, busy["p450"]),
        ).fetchall()
        events = conn.execute(
            "select kind, title, actor"
            " from calendar_events(%s, '2026-11-01', '2026-11-01', %s) order by at",
            (lab.id, NY),
        ).fetchall()
    assert [f[0] for f in files] == [
        "Clean gel0.pdf",
        "Clean gel1.pdf",
        "Clean gel10.pdf",
        "Clean gel11.pdf",
        "Clean gel2.pdf",
    ]
    assert events == [
        ("protocol", "Bradford assay", lab.user_id),
        ("protocol", "Bradford assay", busy["rosa"]),
    ]


def test_a_range_is_short_and_in_a_real_time_zone(conn, busy):
    lab = busy["lab"]
    for start, end, tz in [
        (date(2026, 11, 1), date(2026, 10, 31), NY),
        (date(2026, 1, 1), date(2026, 6, 1), NY),
        (date(2026, 11, 1), date(2026, 11, 7), "Mars/Olympus"),
    ]:
        with as_user(conn, lab.user_id), raises_code("22023"):
            conn.execute("select * from calendar_record(%s, %s, %s, %s)", (lab.id, start, end, tz))


def test_plans_in_a_week_where_the_clocks_go_back(conn, make_lab):
    lab = make_lab()
    with committed_as_user(conn, lab.user_id):
        # 1:30 am happens twice on Nov 1; this is the second one, in standard time.
        second = datetime(2026, 11, 1, 6, 30, tzinfo=UTC)
        overnight = insert_entry(
            conn, lab.id, title="Overnight dialysis", **timed(ny(2026, 10, 31, 22), hours=10)
        )
        repeated = insert_entry(
            conn,
            lab.id,
            title="Second 1:30",
            starts_at=second,
            ends_at=second + timedelta(minutes=30),
        )
        retreat = insert_entry(
            conn, lab.id, title="Retreat", starts_on=date(2026, 11, 6), ends_on=date(2026, 11, 8)
        )
        insert_entry(conn, lab.id, title="Last week", **timed(ny(2026, 10, 30, 9)))
    week = plans(conn, lab.user_id, lab.id, *WEEK)
    assert [p["id"] for p in week] == [str(overnight), str(repeated), str(retreat)]
    by_title = {p["title"]: p for p in week}
    # Ten hours from 10 pm, across the extra hour, ends at 7 am standard time.
    ends = datetime.fromisoformat(by_title["Overnight dialysis"]["ends_at"]).astimezone(
        ZoneInfo(NY)
    )
    assert (ends.hour, ends.utcoffset()) == (7, timedelta(hours=-5))
    # All-day entries are days, the same in every zone.
    assert (by_title["Retreat"]["starts_on"], by_title["Retreat"]["ends_on"]) == (
        "2026-11-06",
        "2026-11-08",
    )
    tokyo = plans(conn, lab.user_id, lab.id, date(2026, 11, 8), date(2026, 11, 8), tz="Asia/Tokyo")
    assert [p["title"] for p in tokyo] == ["Retreat"]


def test_plans_filter_by_their_links(conn, make_lab):
    lab = make_lab()
    exp = add_experiment(conn, lab.id, "P450")
    rosa = add_person(conn, lab.id, "Rosa")
    reader, _ = add_instrument(conn, lab.id, "SpectraMax")
    day = {"starts_on": date(2026, 11, 5), "ends_on": date(2026, 11, 5)}
    with committed_as_user(conn, lab.user_id):
        insert_entry(conn, lab.id, title="Experiment", experiment_id=exp, **day)
        insert_entry(conn, lab.id, title="Person", person_ids=[rosa], **day)
        insert_entry(conn, lab.id, title="Instrument", instrument_id=reader, **day)
    titles = lambda **f: [p["title"] for p in plans(conn, lab.user_id, lab.id, *WEEK, **f)]  # noqa: E731
    assert titles(experiment=exp) == ["Experiment"]
    assert titles(person=rosa) == ["Person"]
    assert titles(instrument=reader) == ["Instrument"]


def test_overlapping_bookings_of_an_instrument_are_found(conn, make_lab):
    lab = make_lab()
    reader, _ = add_instrument(conn, lab.id, "SpectraMax")
    other, _ = add_instrument(conn, lab.id, "AKTA")
    with committed_as_user(conn, lab.user_id):
        mine = insert_entry(
            conn, lab.id, title="Mine", instrument_id=reader, **timed(ny(2026, 11, 5, 14), 2)
        )
        theirs = insert_entry(
            conn, lab.id, title="Theirs", instrument_id=reader, **timed(ny(2026, 11, 5, 15))
        )
        insert_entry(
            conn, lab.id, title="Back to back", instrument_id=reader, **timed(ny(2026, 11, 5, 16))
        )
        insert_entry(
            conn,
            lab.id,
            title="Other instrument",
            instrument_id=other,
            **timed(ny(2026, 11, 5, 14)),
        )
        all_day = insert_entry(
            conn,
            lab.id,
            title="Service day",
            instrument_id=reader,
            starts_on=date(2026, 11, 5),
            ends_on=date(2026, 11, 5),
        )

    def overlaps(start, end, tz=NY):
        with as_user(conn, lab.user_id):
            rows = conn.execute(
                "select * from calendar_overlaps(%s, %s, %s, %s, %s, %s)",
                (lab.id, reader, start, end, tz, mine),
            ).fetchall()
        return [r[0]["id"] for r in rows]

    assert overlaps(ny(2026, 11, 5, 14), ny(2026, 11, 5, 16)) == [str(all_day), str(theirs)]
    # The service day is Thursday in New York, not yet Thursday at 11 pm Wednesday there.
    assert overlaps(ny(2026, 11, 4, 23), ny(2026, 11, 4, 23, 59)) == []
    assert overlaps(ny(2026, 11, 4, 23), ny(2026, 11, 4, 23, 59), tz="UTC") == [str(all_day)]


def test_a_protocol_lists_its_coming_entries(conn, make_lab):
    lab = make_lab()
    protocol = make_protocol(conn, lab, "Bradford")
    now = datetime.now(UTC)
    with committed_as_user(conn, lab.user_id):
        insert_entry(
            conn, lab.id, title="Done", protocol_id=protocol, **timed(now - timedelta(days=2))
        )
        soon = insert_entry(
            conn, lab.id, title="Soon", protocol_id=protocol, **timed(now + timedelta(days=1))
        )
        later = insert_entry(
            conn, lab.id, title="Later", protocol_id=protocol, **timed(now + timedelta(days=3))
        )
        insert_entry(conn, lab.id, title="Unlinked", **timed(now + timedelta(days=1)))
    with as_user(conn, lab.user_id):
        rows = conn.execute(
            "select * from calendar_upcoming(%s, %s, 5)", (lab.id, protocol)
        ).fetchall()
    assert [r[0]["id"] for r in rows] == [str(soon), str(later)]


def test_a_month_of_a_20000_file_lab_is_counted_quickly(conn, make_lab):
    lab = make_lab("pilot")
    exps = [add_experiment(conn, lab.id, f"Experiment {i}") for i in range(8)]
    start = date(2026, 1, 1)
    # Labeled files across a year, and a fifth with no label date at all.
    conn.execute(
        "insert into blobs (sha256, size, mime, file_kind)"
        " select encode(sha256(('pilot' || g)::bytea), 'hex'), 1, 'application/pdf', 'pdf'"
        " from generate_series(1, 20000) g"
    )
    conn.execute(
        "insert into file_locations (lab_id, source_id, external_id, path, original_name, size,"
        " modified_at, source_rev, sha256, index_state)"
        " select %s, %s, 'f' || g, '/f' || g, 'f' || g || '.pdf', 1,"
        " %s::timestamptz + (g %% 365) * interval '1 day' + (g %% 24) * interval '1 hour', 'r',"
        " encode(sha256(('pilot' || g)::bytea), 'hex'), 'indexed' from generate_series(1, 20000) g",
        (lab.id, lab.source_id, start),
    )
    conn.execute(
        "insert into labels"
        " (lab_id, sha256, status, clean_name, date, experiment_id, confidence, source)"
        " select %s, encode(sha256(('pilot' || g)::bytea), 'hex'), 'accepted', 'File ' || g,"
        " %s::date + (g * 7 %% 365), (%s::uuid[])[1 + g %% 8], 0.9, 'test'"
        " from generate_series(1, 20000) g where g %% 5 <> 0",
        (lab.id, start, exps),
    )
    conn.execute("analyze file_locations; analyze labels")
    began = time.perf_counter()
    rows = record(conn, lab.user_id, lab.id, date(2026, 6, 28), date(2026, 8, 8))
    took = time.perf_counter() - began
    total = sum(r[3] for r in rows)
    assert 2000 < total < 3000
    assert len(rows) <= 42 * 9
    assert took < 1.5, f"a month took {took:.2f} s"
    print(f"\n42 days of a 20,000-file lab: {len(rows)} rows, {total} files, {took * 1000:.0f} ms")
