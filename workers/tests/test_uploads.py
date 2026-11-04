import hashlib
import shutil
import uuid
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import psycopg
import pytest
from conftest import as_user, committed_as_user, run_scan, search
from psycopg.types.json import Jsonb
from test_tier1 import CTX, P450_3, file

from bl_worker import samples
from bl_worker.domain import FileKind, SourceKind, SourceReadError, SourceRow
from bl_worker.labels import job
from bl_worker.labels.domain import LabelStatus, Strength, Upload
from bl_worker.labels.tier1 import tier1
from bl_worker.previews import file_key
from bl_worker.process import Outcome
from bl_worker.sources import build_reader

MAX_BYTES = 50 * 1024 * 1024
TODAY = datetime.now(UTC).date()


def store_upload(rt, lab_id, data: bytes) -> str:
    """What the web app's upload route does before it calls record_upload."""
    sha = hashlib.sha256(data).hexdigest()
    rt.previews.put(file_key(lab_id, sha), data)
    return sha


def record(conn, user_id, lab_id, sha, *, size=10, name="gel.jpg", experiment=None, on=TODAY):
    with committed_as_user(conn, user_id):
        return conn.execute(
            "select location_id, duplicate from record_upload(%s, %s, %s, %s, %s, %s, %s)",
            (lab_id, sha, size, name, experiment, on, datetime.now(UTC)),
        ).fetchone()


def upload(rt, conn, lab, data, **kw):
    sha = store_upload(rt, lab.id, data)
    return sha, record(conn, lab.user_id, lab.id, sha, size=len(data), **kw)


def upload_source(conn, lab_id) -> uuid.UUID:
    (source_id,) = conn.execute(
        "select id from sources where lab_id = %s and kind = 'upload'", (lab_id,)
    ).fetchone()
    return source_id


def add_member(conn, lab_id, name: str) -> uuid.UUID:
    user_id = uuid.uuid4()
    conn.execute(
        "insert into auth.users (id, email, raw_user_meta_data) values (%s, %s, %s)",
        (user_id, f"{user_id}@x.edu", Jsonb({"full_name": name})),
    )
    conn.execute(
        "insert into members (lab_id, user_id, role) values (%s, %s, 'member')", (lab_id, user_id)
    )
    return user_id


def phone_photo() -> bytes:
    """A gel photo as a phone camera input hands it over: no EXIF capture time."""
    return samples.gel_jpeg(seed=11, make="Apple", model="iPhone 15", taken="")


def test_an_uploaded_photo_ends_up_indexed_labeled_and_searchable(rt, conn, make_lab):
    lab = make_lab()
    priya = add_member(conn, lab.id, "Priya Nair")
    data = phone_photo()
    sha = store_upload(rt, lab.id, data)
    location_id, duplicate = record(
        conn, priya, lab.id, sha, size=len(data), name="photo.jpg", experiment="P450 BM3"
    )
    assert duplicate is False

    assert run_scan(rt, upload_source(conn, lab.id)) == [Outcome.INDEXED]
    draft = job.label_blob(rt, lab.id, sha)

    path, state, kind = conn.execute(
        "select fl.path, fl.index_state, b.file_kind from file_locations fl"
        " join blobs b using (sha256) where fl.id = %s",
        (location_id,),
    ).fetchone()
    assert (path, state, kind) == ("/Uploads/P450 BM3/photo.jpg", "indexed", "image")
    person, experiment, day, status = conn.execute(
        "select p.display_name, e.name, l.date, l.status from labels l"
        " join people p on p.id = l.person_id join experiments e on e.id = l.experiment_id"
        " where l.lab_id = %s and l.sha256 = %s",
        (lab.id, sha),
    ).fetchone()
    assert (person, experiment, day) == ("Priya Nair", "P450 BM3", TODAY)
    assert draft is not None and LabelStatus(status) is draft.status
    assert conn.execute(
        "select member_user_id from people where lab_id = %s and display_name = 'Priya Nair'",
        (lab.id,),
    ).fetchone() == (priya,)

    with as_user(conn, priya):
        hits = search(conn, lab.id, "P450 BM3 photo", None)
        assert [h["sha256"] for h in hits] == [sha]
        assert hits[0]["locations"][0]["source_kind"] == "upload"
        assert hits[0]["label"]["person"]["name"] == "Priya Nair"
        mine = conn.execute(
            "select index_state, experiment, (label ->> 'date')::date from my_uploads(%s)",
            (lab.id,),
        ).fetchall()
        assert mine == [("indexed", "P450 BM3", TODAY)]


def test_an_uploaded_pdf_is_searchable_by_its_text(rt, conn, make_lab):
    lab = make_lab()
    sha, _ = upload(rt, conn, lab, samples.pdf(["Ni-NTA elution, 250 mM imidazole"]), name="a.pdf")
    assert run_scan(rt, upload_source(conn, lab.id)) == [Outcome.INDEXED]
    with as_user(conn, lab.user_id):
        assert [h["sha256"] for h in search(conn, lab.id, "imidazole", None)] == [sha]


def test_the_same_bytes_again_are_one_blob_one_location_and_one_upload(rt, conn, make_lab):
    lab = make_lab()
    other = add_member(conn, lab.id, "Chen Du")
    data = phone_photo()
    sha, (first, dup1) = upload(rt, conn, lab, data, experiment="P450 BM3")
    second, dup2 = record(conn, lab.user_id, lab.id, sha, size=len(data))
    third, dup3 = record(conn, other, lab.id, sha, size=len(data), name="again.jpg")
    run_scan(rt, upload_source(conn, lab.id))

    assert (dup1, dup2, dup3) == (False, True, True)
    assert first == second == third
    counts = conn.execute(
        "select (select count(*) from blobs where sha256 = %(sha)s),"
        " (select count(*) from file_locations where lab_id = %(lab)s),"
        " (select count(*) from uploads where lab_id = %(lab)s),"
        " (select count(*) from sources where lab_id = %(lab)s and kind = 'upload')",
        {"sha": sha, "lab": lab.id},
    ).fetchone()
    assert counts == (1, 1, 1, 1)


def test_a_second_upload_source_for_a_lab_is_refused(conn, make_lab):
    lab = make_lab()
    record(conn, lab.user_id, lab.id, "a" * 64)
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute(
            "insert into sources (lab_id, kind, root_path) values (%s, 'upload', '/')", (lab.id,)
        )


def test_a_failed_upload_goes_back_to_pending_when_sent_again(rt, conn, make_lab):
    lab = make_lab()
    data = phone_photo()
    sha = hashlib.sha256(data).hexdigest()
    location_id, _ = record(conn, lab.user_id, lab.id, sha, size=len(data))
    assert run_scan(rt, upload_source(conn, lab.id)) == [Outcome.FAILED]

    store_upload(rt, lab.id, data)
    record(conn, lab.user_id, lab.id, sha, size=len(data))
    assert run_scan(rt, upload_source(conn, lab.id)) == [Outcome.INDEXED]
    assert conn.execute(
        "select index_state from file_locations where id = %s", (location_id,)
    ).fetchone() == ("indexed",)


@pytest.mark.parametrize(
    ("size", "on", "code"),
    [
        (MAX_BYTES + 1, TODAY, "BL201"),
        (MAX_BYTES, TODAY + timedelta(days=3), "22023"),
        (-1, TODAY, "22023"),
    ],
)
def test_bad_uploads_are_refused(conn, make_lab, size, on, code):
    lab = make_lab()
    with pytest.raises(psycopg.Error) as err:
        record(conn, lab.user_id, lab.id, "b" * 64, size=size, on=on)
    assert err.value.sqlstate == code
    assert conn.execute("select count(*) from file_locations").fetchone() == (0,)


def test_the_size_cap_is_the_one_the_web_app_checks(conn):
    assert conn.execute("select upload_max_bytes()").fetchone() == (MAX_BYTES,)


def test_a_member_of_one_lab_cannot_upload_into_or_read_another(rt, conn, make_lab):
    a, b = make_lab("a"), make_lab("b")
    b_sha, (b_location, _) = upload(rt, conn, b, phone_photo(), experiment="Secret")
    run_scan(rt, upload_source(conn, b.id))

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        record(conn, a.user_id, b.id, "c" * 64)
    with as_user(conn, a.user_id):
        for query in (
            "select count(*) from uploads where lab_id = %s",
            "select count(*) from file_locations where lab_id = %s",
            "select count(*) from my_uploads(%s)",
            "select count(*) from sources where lab_id = %s",
            "select count(*) from experiments where lab_id = %s",
        ):
            assert conn.execute(query, (b.id,)).fetchone() == (0,), query
        assert search(conn, b.id, "Secret", None) == []

    # The store key comes from the location's own lab, so lab A's reader can't reach B's bytes.
    a_reader = build_reader(
        SourceRow(uuid.uuid4(), a.id, SourceKind.UPLOAD, "/", None, None), rt.settings, rt.previews
    )
    with pytest.raises(SourceReadError):
        a_reader.read(b_sha)
    assert b_location is not None


def test_everything_a_lab_puts_in_the_store_sits_under_its_prefix(rt, conn, make_lab):
    a, b = make_lab("a"), make_lab("b")
    a_sha, _ = upload(rt, conn, a, phone_photo())
    upload(rt, conn, a, samples.pdf(["P450 notes"]), name="notes.pdf")
    b_sha, _ = upload(rt, conn, b, samples.gel_jpeg(seed=3))
    for lab in (a, b):
        run_scan(rt, upload_source(conn, lab.id))

    root = rt.settings.preview_dir
    keys = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    a_keys = [k for k in keys if k.startswith(f"{a.id}/")]
    assert len(a_keys) == 4, keys  # two files, two previews
    assert all(k.startswith((f"{a.id}/", f"{b.id}/")) for k in keys)

    # Lab deletion removes <lab_id>/ from the store; afterwards no upload of A can be read.
    shutil.rmtree(root / str(a.id))
    conn.execute("update file_locations set index_state = 'pending' where lab_id = %s", (a.id,))
    assert run_scan(rt, upload_source(conn, a.id)) == [Outcome.FAILED, Outcome.FAILED]
    assert rt.previews.get(file_key(b.id, b_sha)) is not None
    assert rt.previews.get(file_key(a.id, a_sha)) is None


def test_scanning_an_upload_source_never_marks_uploads_deleted(rt, conn, make_lab):
    lab = make_lab()
    upload(rt, conn, lab, phone_photo())
    source = upload_source(conn, lab.id)
    run_scan(rt, source)
    conn.execute("update sources set cursor = null where id = %s", (source,))
    assert run_scan(rt, source) == []
    assert conn.execute(
        "select count(*) from file_locations where source_id = %s and deleted_at is null",
        (source,),
    ).fetchone() == (1,)


def test_upload_facts_fill_person_date_and_experiment_but_a_camera_date_wins():
    who = CTX.people[0]
    sent = Upload(person_id=who.id, experiment_id=P450_3.id, uploaded_on=date(2026, 11, 4))
    plain = tier1(replace(file("/Uploads/photo.jpg", FileKind.IMAGE), upload=sent), CTX)
    assert plain.person is not None and plain.person.value == who
    assert plain.person.strength is Strength.STRONG
    assert plain.experiment is not None and plain.experiment.value == P450_3
    assert plain.date is not None and plain.date.value == date(2026, 11, 4)

    exif = {"exif": {"DateTimeOriginal": "2026:10:30 09:00:00"}}
    taken = replace(file("/Uploads/photo.jpg", FileKind.IMAGE, meta=exif), upload=sent)
    dated = tier1(taken, CTX)
    assert dated.date is not None and dated.date.value == date(2026, 10, 30)
    assert dated.conflicts == ()
