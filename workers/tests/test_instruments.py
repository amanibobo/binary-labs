import hashlib
import uuid
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan, search
from test_tier1 import CTX, file

from bl_worker.domain import FileKind
from bl_worker.labels import job
from bl_worker.labels.domain import Strength
from bl_worker.labels.tier1 import tier1
from bl_worker.previews import file_key
from bl_worker.process import Outcome

NOW = datetime.now(UTC)


def h(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def raises_code(code):
    return pytest.raises(psycopg.Error, check=lambda e: e.sqlstate == code)


@contextmanager
def as_server(conn):
    """The web server's service role, the only caller of the uploader's functions."""
    with conn.transaction():
        conn.execute("set local role service_role")
        yield conn


def add_instrument(conn, lab, name="Plate reader, room 214", code="K7QM4XPA"):
    with committed_as_user(conn, lab.user_id):
        (instrument_id, _) = conn.execute(
            "select * from create_instrument(%s, %s, %s)", (lab.id, name, h(code))
        ).fetchone()
    return instrument_id


def pair(conn, code, token, client="client"):
    with as_server(conn):
        return conn.execute(
            "select outcome, paired_id from pair_instrument(%s, %s, %s)",
            (h(code), h(token), client),
        ).fetchone()


def session(conn, token):
    with as_server(conn):
        return conn.execute(
            "select instrument_id, lab_id, source_id from instrument_session(%s)", (h(token),)
        ).fetchone()


def record(conn, token, path, sha, size=10, modified_at=NOW):
    with as_server(conn):
        return conn.execute(
            "select location_id, duplicate from record_instrument_file(%s, %s, %s, %s, %s)",
            (h(token), path, sha, size, modified_at),
        ).fetchone()


def send(rt, conn, lab, token, path, data: bytes):
    """What the web app does: verified bytes go to the store, then the location is recorded."""
    sha = hashlib.sha256(data).hexdigest()
    rt.previews.put(file_key(lab.id, sha), data)
    return sha, record(conn, token, path, sha, len(data))


def instrument_source(conn, instrument_id):
    return conn.execute(
        "select source_id from instruments where id = %s", (instrument_id,)
    ).fetchone()[0]


def location_source(conn, location_id):
    return conn.execute(
        "select source_id from file_locations where id = %s", (location_id,)
    ).fetchone()[0]


def test_a_code_pairs_once_and_only_while_fresh(conn, make_lab):
    lab = make_lab()
    instrument = add_instrument(conn, lab)

    assert pair(conn, "WRONG000", "t0") == ("refused", None)
    assert pair(conn, "K7QM4XPA", "t1") == ("paired", instrument)
    assert session(conn, "t1")[0] == instrument
    assert pair(conn, "K7QM4XPA", "t2") == ("refused", None), "a code is single use"
    assert session(conn, "t2") is None

    expiring = add_instrument(conn, lab, name="NanoDrop", code="EXP1RED0")
    conn.execute(
        "update instruments set pairing_expires_at = now() - interval '1 second' where id = %s",
        (expiring,),
    )
    assert pair(conn, "EXP1RED0", "t3") == ("refused", None)
    with as_user(conn, lab.user_id):
        states = dict(conn.execute("select name, state from lab_instruments(%s)", (lab.id,)))
    assert states == {"Plate reader, room 214": "paired", "NanoDrop": "expired"}

    with committed_as_user(conn, lab.user_id):
        conn.execute("select renew_pairing_code(%s, %s)", (expiring, h("FRESH000")))
    assert pair(conn, "FRESH000", "t3") == ("paired", expiring)
    with committed_as_user(conn, lab.user_id), raises_code("BL302"):
        conn.execute("select renew_pairing_code(%s, %s)", (expiring, h("AGAIN000")))


def test_a_revoked_token_stops_at_once_and_its_files_stay(rt, conn, make_lab):
    lab = make_lab()
    instrument = add_instrument(conn, lab)
    pair(conn, "K7QM4XPA", "tok")
    send(rt, conn, lab, "tok", "Exports/run1.csv", b"well,od\nA1,0.5\n")

    with committed_as_user(conn, lab.user_id):
        conn.execute("select revoke_instrument(%s)", (instrument,))
        conn.execute("select revoke_instrument(%s)", (instrument,))
    assert session(conn, "tok") is None
    with raises_code("28000"):
        record(conn, "tok", "Exports/run2.csv", "a" * 64)
    with as_user(conn, lab.user_id):
        row = conn.execute("select state, files from lab_instruments(%s)", (lab.id,)).fetchone()
    assert row == ("revoked", 1)
    actions = [
        r[0]
        for r in conn.execute(
            "select action from audit_log where lab_id = %s and action::text like 'instrument.%%'"
            " order by id",
            (lab.id,),
        )
    ]
    assert actions == ["instrument.create", "instrument.pair", "instrument.revoke"]


def test_pairing_tries_are_limited_per_caller(conn, make_lab):
    lab = make_lab()
    instrument = add_instrument(conn, lab)
    for i in range(10):
        assert pair(conn, f"GUESS{i:03d}", "t", client="guesser")[0] == "refused"
    assert pair(conn, "K7QM4XPA", "t", client="guesser")[0] == "limited"
    assert pair(conn, "K7QM4XPA", "t", client="the lab manager") == ("paired", instrument)


def test_only_admins_add_and_revoke_and_nobody_reads_secrets(conn, make_lab):
    lab = make_lab()
    instrument = add_instrument(conn, lab)
    member = uuid.uuid4()
    conn.execute("insert into auth.users (id) values (%s)", (member,))
    conn.execute(
        "insert into members (lab_id, user_id, role) values (%s, %s, 'member')", (lab.id, member)
    )
    with as_user(conn, member), raises_code("42501"):
        conn.execute("select create_instrument(%s, 'Mine', %s)", (lab.id, h("X")))
    with as_user(conn, member), raises_code("42501"):
        conn.execute("select revoke_instrument(%s)", (instrument,))
    with as_user(conn, member):
        assert conn.execute("select count(*) from lab_instruments(%s)", (lab.id,)).fetchone() == (
            1,
        )
    for column in ("pairing_code_hash", "token_hash"):
        with as_user(conn, member), raises_code("42501"):
            conn.execute(f"select {column} from instruments")
    for call in (
        "select pair_instrument('x', %s, 'c')",
        "select instrument_session(%s)",
        "select record_instrument_file(%s, 'a/b.csv', repeat('a', 64), 1, now())",
    ):
        with as_user(conn, lab.user_id), raises_code("42501"):
            conn.execute(call, (h("tok"),))
    with committed_as_user(conn, lab.user_id), raises_code("BL301"):
        conn.execute("select create_instrument(%s, 'plate reader, room 214', %s)", (lab.id, h("Y")))


def test_a_token_writes_only_to_its_own_instrument_in_its_own_lab(rt, conn, make_lab):
    a, b = make_lab("a"), make_lab("b")
    reader = add_instrument(conn, a, name="Plate reader")
    other = add_instrument(conn, a, name="qPCR", code="QPCR0000")
    b_instrument = add_instrument(conn, b, name="Plate reader", code="LABB0000")
    pair(conn, "K7QM4XPA", "a-tok")
    pair(conn, "QPCR0000", "qpcr-tok")
    pair(conn, "LABB0000", "b-tok")

    sha, (location, duplicate) = send(rt, conn, a, "a-tok", "Exports/run1.csv", b"A1,0.5\n")
    assert duplicate is False
    row = conn.execute(
        "select lab_id, source_id, path, external_id, source_rev from file_locations where id = %s",
        (location,),
    ).fetchone()
    assert row == (
        a.id,
        instrument_source(conn, reader),
        "/Instruments/Plate reader/Exports/run1.csv",
        "Exports/run1.csv",
        sha,
    )
    assert conn.execute(
        "select count(*) from file_locations where source_id = any(%s)",
        ([instrument_source(conn, other), instrument_source(conn, b_instrument)],),
    ).fetchone() == (0,)
    with as_user(conn, b.user_id):
        assert conn.execute(
            "select count(*) from file_locations where lab_id = %s", (a.id,)
        ).fetchone() == (0,)
        assert conn.execute("select count(*) from lab_instruments(%s)", (a.id,)).fetchone() == (0,)


def test_the_same_bytes_at_the_same_path_are_one_file_and_new_bytes_reindex(rt, conn, make_lab):
    lab = make_lab()
    add_instrument(conn, lab)
    pair(conn, "K7QM4XPA", "tok")
    sha, (location, _) = send(rt, conn, lab, "tok", "Exports/run1.csv", b"A1,0.5\n")
    source = location_source(conn, location)
    assert run_scan(rt, source) == [Outcome.INDEXED]

    assert record(conn, "tok", "Exports/run1.csv", sha, 7) == (location, True)
    assert run_scan(rt, source) == [], "an unchanged file isn't read again"

    new_sha, again = send(rt, conn, lab, "tok", "Exports/run1.csv", b"A1,0.9\n")
    assert again == (location, False)
    assert run_scan(rt, source) == [Outcome.INDEXED]
    assert conn.execute(
        "select sha256, index_state from file_locations where id = %s", (location,)
    ).fetchone() == (new_sha, "indexed")


def test_bad_paths_and_sizes_are_refused(conn, make_lab):
    lab = make_lab()
    add_instrument(conn, lab)
    pair(conn, "K7QM4XPA", "tok")
    for path in ("/abs.csv", "a//b.csv", "a/../b.csv", "./b.csv", "a\\b.csv", "a/", ""):
        with raises_code("22023"):
            record(conn, "tok", path, "a" * 64)
    with raises_code("BL201"):
        record(conn, "tok", "a.csv", "a" * 64, size=500 * 1024 * 1024 + 1)


def test_an_instrument_file_is_indexed_labeled_with_the_instrument_and_browsed(rt, conn, make_lab):
    lab = make_lab()
    with committed_as_user(conn, lab.user_id):
        conn.execute("insert into experiments (lab_id, name) values (%s, 'P450')", (lab.id,))
    add_instrument(conn, lab)
    pair(conn, "K7QM4XPA", "tok")
    data = b"SpectraMax M5\nWell,Fluorescence\nA1,1200\nA2,1350\n"
    sha, (location, _) = send(rt, conn, lab, "tok", "Exports/P450/plate07_read1.csv", data)
    source = location_source(conn, location)
    assert run_scan(rt, source) == [Outcome.INDEXED]

    draft = job.label_blob(rt, lab.id, sha)
    assert draft is not None and draft.instrument == "Plate reader, room 214"
    with as_user(conn, lab.user_id):
        assert conn.execute(
            "select instrument from labels where lab_id = %s and sha256 = %s", (lab.id, sha)
        ).fetchone() == ("Plate reader, room 214",)
        folders = {r[0] for r in conn.execute("select path from folder_tree(%s)", (lab.id,))}
        assert "Instruments/Plate reader, room 214/Exports/P450" in folders
    hits = search(conn, lab.id, "plate reader room 214", None)
    assert [hit["sha256"] for hit in hits] == [sha]


def test_the_instrument_outranks_a_header_signature_without_a_conflict():
    f = replace(
        file("Exports/run1.csv", FileKind.SPREADSHEET, text="SpectraMax M5 export"),
        instrument="Plate reader, room 214",
    )
    t1 = tier1(f, CTX)
    assert t1.instrument is not None
    assert t1.instrument.value == "Plate reader, room 214"
    assert t1.instrument.strength == Strength.TAUGHT
    assert t1.conflicts == ()
    assert tier1(replace(f, instrument=None), CTX).instrument.value == "SpectraMax"
