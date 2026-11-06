"""A fake, fully populated lab for an existing user, so the app can be seen with real data
(bl demo-lab). Everything a person would do goes through the app's own SQL functions as that
user, with RLS on; only what no function writes is done as the table owner: marking the lab as
the demo, the imported folder's locations (as the worker writes a scan's), the instrument's
pairing and files (the service role's functions) and back-dating so the lab looks months old.

The lab is labs.plan = 'demo' with the user as admin; that pair is the only thing this module
ever finds, changes or deletes. Building happens in steps that each converge:

1. seed: one transaction makes the lab, its lists, protocols, instrument and every file's
   location, after putting the bytes in the object store. A lab exists only if all of it does.
2. the worker indexes and labels the files (settle).
3. finish: links files to protocols and saves charts, which need the files' hashes from the
   worker; each is skipped when already there.
4. the worker links the video, transcribes it and the talk-through and drafts its steps.

Running it again finds the lab and redoes only steps 2 to 4, which then change nothing."""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from bl_worker import deletion
from bl_worker.demo_content import (
    CHARTS,
    EXPERIMENTS,
    INSTRUMENT,
    LAB_NAME,
    OPENED,
    PEOPLE,
    PROTOCOLS,
    TALK_THROUGH,
    TALK_THROUGH_MS,
    TALK_THROUGH_PROTOCOL,
    VIDEO,
    VIDEO_PROTOCOL,
    DemoFile,
    Via,
    files,
)
from bl_worker.filekind import detect
from bl_worker.previews import PreviewStore, file_key, lab_prefix
from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

DEMO_PLAN = "demo"
IMPORT_LABEL = "Okafor Lab folder"


class DemoError(Exception):
    """Something the operator has to fix: no such user, say."""


def find_admin(conn: psycopg.Connection, *, email: str | None, user_id: UUID | None) -> UUID:
    if user_id is not None:
        row = conn.execute("select id from auth.users where id = %s", (user_id,)).fetchone()
    else:
        row = conn.execute(
            "select id from auth.users where lower(email) = lower(%s)", (email,)
        ).fetchone()
    if row is None:
        raise DemoError(f"no auth user {user_id or email}; sign in to the app once first")
    return row[0]


def demo_labs(conn: psycopg.Connection, admin: UUID) -> list[UUID]:
    """This user's demo labs that aren't being deleted. Never any other lab."""
    rows = conn.execute(
        "select l.id from labs l join members m on m.lab_id = l.id"
        " where m.user_id = %s and m.role = 'admin' and l.plan = %s"
        " and l.deletion_requested_at is null order by l.created_at",
        (admin, DEMO_PLAN),
    )
    return [r[0] for r in rows]


@contextmanager
def as_user(conn: psycopg.Connection, user: UUID) -> Iterator[None]:
    """Supabase's authenticated role with the user's JWT subject, so RLS and auth.uid() apply
    as they do for the web app. Undone at the end, inside the caller's transaction."""
    claims = json.dumps({"sub": str(user), "role": "authenticated"})
    conn.execute("set local role authenticated")
    conn.execute("select set_config('request.jwt.claims', %s, true)", (claims,))
    conn.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(user),))
    yield
    # Not in a finally: after an error the transaction is rolled back, which undoes these too.
    conn.execute("set local role none")
    conn.execute("select set_config('request.jwt.claims', '', true)")
    conn.execute("select set_config('request.jwt.claim.sub', '', true)")


def _one(conn: psycopg.Connection, sql: str, args: Any = None) -> Any:
    row = conn.execute(sql, args).fetchone()
    assert row is not None, sql
    return row[0]


def _store(store: PreviewStore, lab: UUID, f: DemoFile) -> None:
    _, mime = detect(f.path, f.data)
    store.put(file_key(lab, f.sha256), f.data, mime)


def _today() -> datetime:
    return datetime.now(UTC)


def seed(conn: psycopg.Connection, store: PreviewStore, admin: UUID) -> UUID:
    """Step 1, in one transaction: a lab with everything but what needs the worker first."""
    demo_files = files()
    lab = None
    try:
        with conn.transaction():
            with as_user(conn, admin):
                lab = _one(conn, "select create_lab(%s)", (LAB_NAME,))
            conn.execute(
                "update labs set plan = %s, created_at = %s where id = %s", (DEMO_PLAN, OPENED, lab)
            )
            conn.execute("update members set created_at = %s where lab_id = %s", (OPENED, lab))
            for f in [*demo_files, VIDEO, TALK_THROUGH]:
                _store(store, lab, f)
            with as_user(conn, admin):
                _lists(conn, lab)
                pages = _protocols(conn, lab)
            _backdate_protocols(conn, lab)
            with as_user(conn, admin):
                for p in PROTOCOLS:
                    if p.experiments:
                        conn.execute(
                            "update experiments set protocol_id = %s"
                            " where lab_id = %s and name = any(%s)",
                            (pages[p.versions[0].title], lab, p.experiments),
                        )
            _import(conn, lab, [f for f in demo_files if f.via is Via.IMPORT])
            _instrument(conn, lab, admin, [f for f in demo_files if f.via is Via.INSTRUMENT])
            _uploads(conn, lab, admin, [f for f in demo_files if f.via is Via.UPLOAD], pages)
    except BaseException:
        if lab is not None:
            store.delete_prefix(lab_prefix(lab))
        raise
    return lab


def _lists(conn: psycopg.Connection, lab: UUID) -> None:
    for name, aliases in EXPERIMENTS:
        conn.execute(
            "insert into experiments (lab_id, name, aliases) values (%s, %s, %s)",
            (lab, name, aliases),
        )
    for name, aliases in PEOPLE:
        conn.execute(
            "insert into people (lab_id, display_name, aliases) values (%s, %s, %s)",
            (lab, name, aliases),
        )


def _protocols(conn: psycopg.Connection, lab: UUID) -> dict[str, UUID]:
    """Each page and its versions, saved one on top of the other as people edit them. Keyed by
    the first title, which never changes."""
    pages: dict[str, UUID] = {}
    for p in PROTOCOLS:
        first, *later = p.versions
        page, version, _ = conn.execute(
            "select * from create_protocol(%s, %s, %s, %s, %s)",
            (lab, p.kind, first.title, first.body, first.note),
        ).fetchone()  # type: ignore[misc]
        for v in later:
            _, version, _ = conn.execute(
                "select * from save_protocol(%s, %s, %s, %s, %s)",
                (page, version, v.title, v.body, v.note),
            ).fetchone()  # type: ignore[misc]
        pages[first.title] = page
    return pages


def _backdate_protocols(conn: psycopg.Connection, lab: UUID) -> None:
    for p in PROTOCOLS:
        page = _one(
            conn,
            "select v.protocol_id from protocol_versions v"
            " where v.lab_id = %s and v.version = 1 and v.title = %s",
            (lab, p.versions[0].title),
        )
        for n, v in enumerate(p.versions, start=1):
            conn.execute(
                "update protocol_versions set created_at = %s"
                " where protocol_id = %s and version = %s",
                (v.at, page, n),
            )
        conn.execute("update protocols set created_at = %s where id = %s", (p.versions[0].at, page))


def _import(conn: psycopg.Connection, lab: UUID, imported: list[DemoFile]) -> None:
    """The lab folder: one import source, each file at its own path, read from our store by
    its sha256 (decisions.md, "bl demo-lab")."""
    source = _one(
        conn,
        "insert into sources (lab_id, kind, root_path, account_label, created_at)"
        " values (%s, 'import', '/', %s, %s) returning id",
        (lab, IMPORT_LABEL, OPENED),
    )
    with conn.cursor() as cur:
        cur.executemany(
            "insert into file_locations (lab_id, source_id, external_id, path, original_name,"
            " size, modified_at, source_rev) values (%s, %s, %s, %s, %s, %s, %s, %s)",
            [
                (
                    lab,
                    source,
                    f.path,
                    "/" + f.path,
                    f.path.rsplit("/", 1)[-1],
                    len(f.data),
                    f.modified,
                    f.sha256,
                )
                for f in imported
            ],
        )
    conn.execute(
        "update sources set scan_requested_at = clock_timestamp() where id = %s", (source,)
    )


def _instrument(conn: psycopg.Connection, lab: UUID, admin: UUID, sent: list[DemoFile]) -> None:
    """Added in Settings by the admin, paired by its uploader, files sent from its PC. The
    token is thrown away: nothing can send to this instrument after the demo is built."""
    code_hash = hashlib.sha256(secrets.token_bytes(16)).hexdigest()
    token_hash = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
    with as_user(conn, admin):
        instrument = _one(
            conn,
            "select instrument_id from create_instrument(%s, %s, %s)",
            (lab, INSTRUMENT, code_hash),
        )
    outcome = _one(
        conn,
        "select outcome from pair_instrument(%s, %s, %s)",
        (code_hash, token_hash, "bl demo-lab"),
    )
    if outcome != "paired":
        raise DemoError(f"pairing the demo instrument answered {outcome}")
    for f in sent:
        conn.execute(
            "select * from record_instrument_file(%s, %s, %s, %s, %s)",
            (token_hash, f.path, f.sha256, len(f.data), f.modified),
        )
    conn.execute(
        "update instruments set created_at = %s, paired_at = %s where id = %s",
        (OPENED.replace(day=20), OPENED.replace(day=20), instrument),
    )


def _uploads(
    conn: psycopg.Connection,
    lab: UUID,
    admin: UUID,
    uploads: list[DemoFile],
    pages: dict[str, UUID],
) -> None:
    """Sent by the admin from the upload page, a procedure video added to the purification page
    and a talk-through recorded on it. The functions only take today's date, so each is moved
    back to its day afterwards, before any worker can see it."""
    today = _today().date()
    sent: list[tuple[UUID, DemoFile]] = []
    with as_user(conn, admin):
        for f in uploads:
            location = _one(
                conn,
                "select location_id from record_upload(%s, %s, %s, %s, %s, %s, %s)",
                (lab, f.sha256, len(f.data), f.path, f.experiment, today, f.modified),
            )
            sent.append((location, f))
        location = _one(
            conn,
            "select location_id from record_video(%s, %s, %s, %s, %s, %s, %s)",
            (
                lab,
                VIDEO.sha256,
                len(VIDEO.data),
                VIDEO.path,
                today,
                VIDEO.modified,
                pages[VIDEO_PROTOCOL],
            ),
        )
        sent.append((location, VIDEO))
        page = pages[TALK_THROUGH_PROTOCOL]
        version = _one(conn, "select current_version_id from protocols where id = %s", (page,))
        talk_through, location = conn.execute(
            "select talk_through_id, location_id"
            " from record_talk_through(%s, %s, %s, %s, %s, %s, 'protocol', %s, %s, %s)",
            (
                lab,
                TALK_THROUGH.sha256,
                len(TALK_THROUGH.data),
                TALK_THROUGH.path,
                today,
                TALK_THROUGH.modified,
                page,
                version,
                TALK_THROUGH_MS,
            ),
        ).fetchone()  # type: ignore[misc]
        sent.append((location, TALK_THROUGH))
    for location, f in sent:
        conn.execute(
            "update uploads set uploaded_at = %s, uploaded_on = %s where location_id = %s",
            (f.modified, f.modified.date(), location),
        )
    conn.execute(
        "update talk_throughs set recorded_at = %s where id = %s",
        (TALK_THROUGH.modified, talk_through),
    )
    conn.execute(
        "update pending_protocol_files set requested_at = %s where lab_id = %s",
        (VIDEO.modified, lab),
    )


def finish(conn: psycopg.Connection, lab: UUID, admin: UUID) -> list[str]:
    """Step 3: protocol links and charts, as the admin. Skips what's there; returns what it
    couldn't do yet because a file isn't indexed."""
    by_path = {f.path: f for f in files()}
    missing: list[str] = []

    def indexed(f: DemoFile) -> bool:
        ok = conn.execute(
            "select 1 from file_locations where lab_id = %s and sha256 = %s and deleted_at is null",
            (lab, f.sha256),
        ).fetchone()
        if ok is None:
            missing.append(f.path)
        return ok is not None

    with conn.transaction(), as_user(conn, admin):
        pages = dict(
            conn.execute(
                "select v.title, v.protocol_id from protocol_versions v"
                " where v.lab_id = %s and v.version = 1",
                (lab,),
            ).fetchall()
        )
        for p in PROTOCOLS:
            for path in p.files:
                if indexed(by_path[path]):
                    conn.execute(
                        "select link_protocol_file(%s, %s)",
                        (pages[p.versions[0].title], by_path[path].sha256),
                    )
        for c in CHARTS:
            exists = conn.execute(
                "select 1 from charts where lab_id = %s and title = %s", (lab, c.title)
            ).fetchone()
            if exists is None and indexed(by_path[c.file]):
                conn.execute(
                    "insert into charts (lab_id, sha256, sheet, title, spec, protocol_id)"
                    " values (%s, %s, %s, %s, %s, %s)",
                    (
                        lab,
                        by_path[c.file].sha256,
                        c.sheet,
                        c.title,
                        Jsonb(c.spec),
                        pages[c.protocol] if c.protocol else None,
                    ),
                )
    return missing


UNSETTLED = """
select
  (select count(*) from file_locations
   where lab_id = %(lab)s and deleted_at is null and index_state = 'pending') as pending_files,
  (select count(distinct fl.sha256) from file_locations fl
   left join labels l on l.lab_id = fl.lab_id and l.sha256 = fl.sha256
   where fl.lab_id = %(lab)s and fl.deleted_at is null and fl.sha256 is not null
     and fl.index_state <> 'pending' and l.sha256 is null) as unlabeled,
  (select count(*) from data_tables where lab_id = %(lab)s and state = 'waiting') as tables,
  (select count(*) from pending_protocol_files p join file_locations fl on fl.id = p.location_id
   where p.lab_id = %(lab)s and fl.index_state <> 'failed') as unlinked_videos,
  (select count(*) from protocol_files pf join blobs b on b.sha256 = pf.sha256
   left join videos v on v.lab_id = pf.lab_id and v.sha256 = pf.sha256
   where pf.lab_id = %(lab)s and b.file_kind = 'video'
     and (v.sha256 is null or v.transcript = 'waiting')) as video_transcripts,
  (select count(*) from talk_throughs t join file_locations fl on fl.id = t.location_id
   where t.lab_id = %(lab)s and t.draft = 'waiting' and fl.index_state = 'indexed') as drafts,
  (select count(*) from procrastinate_jobs j
   where j.status in ('todo', 'doing') and (j.args ->> 'lab_id' = %(lab)s::text
     or j.args ->> 'location_id' in (
       select id::text from file_locations where lab_id = %(lab)s)
     or j.args ->> 'source_id' in (select id::text from sources where lab_id = %(lab)s))) as jobs
"""


def unsettled(conn: psycopg.Connection, lab: UUID, *, files_only: bool = False) -> dict[str, int]:
    """What the worker still has to do for this lab; empty when it's done."""
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        row = cur.execute(UNSETTLED, {"lab": lab}).fetchone()
    assert row is not None
    if files_only:
        row = {"pending_files": row["pending_files"]}
    return {k: v for k, v in row.items() if v}


Settle = Callable[[UUID, bool], None]


def build(rt: Runtime, admin: UUID, settle: Settle) -> UUID:
    """Makes the admin's demo lab or finishes the one there; returns its id. `settle(lab,
    files_only)` runs or waits for the worker until unsettled() is empty."""
    with rt.pool.connection() as conn:
        conn.autocommit = False
        try:
            found = demo_labs(conn, admin)
            conn.rollback()
            lab = found[0] if found else seed(conn, rt.previews, admin)
            if found:
                log.info("demo lab %s is there; finishing it", lab)
            else:
                log.info("made demo lab %s", lab)
        finally:
            conn.autocommit = True
    settle(lab, True)
    with rt.pool.connection() as conn:
        missing = finish(conn, lab, admin)
        with conn.transaction(), as_user(conn, admin):
            plan_calendar(conn, lab)
    if missing:
        log.warning("not indexed, so not linked or charted: %s", ", ".join(missing))
    settle(lab, False)
    return lab


# (title, day offset from today, start hour or None for all day, hours or days long,
#  experiment, protocol, uses the plate reader, people, notes)
PLANS: list[tuple[str, int, int | None, int, str | None, str | None, bool, list[str], str]] = [
    ("Lab meeting", -10, 10, 1, None, None, False, [], "Batch 3 yields; SEC traces."),
    ("Lab meeting", -3, 10, 1, None, None, False, [], ""),
    ("Lab meeting", 4, 10, 1, None, None, False, [], "Rotation student introductions."),
    ("Lab meeting", 11, 10, 1, None, None, False, [], ""),
    ("Lab meeting", 18, 10, 1, None, None, False, [], ""),
    (
        "Nickel column, batch 4",
        -8,
        9,
        3,
        "P450 BM3",
        "P450 BM3 purification",
        False,
        ["Priya Nair"],
        "Pool red fractions; dialyse overnight.",
    ),
    (
        "Nickel column, batch 5",
        1,
        9,
        3,
        "P450 BM3",
        "P450 BM3 purification",
        False,
        ["Priya Nair", "Ade Okafor"],
        "",
    ),
    (
        "Bradford standards",
        0,
        14,
        2,
        "P450 BM3",
        "Bradford assay",
        True,
        ["Priya Nair"],
        "Fresh BSA dilutions, 0 to 2 mg/mL. Read at 595 nm after 10 min.",
    ),
    (
        "Plate reads, plates 7 to 9",
        0,
        15,
        1,
        "Thermal shift screen plate 07",
        None,
        True,
        ["Jordan Morales"],
        "",
    ),
    ("DSF screen, lysozyme", 6, 13, 3, "Lysozyme DSF", None, True, ["Chen Du"], ""),
    (
        "SDS-PAGE of batch 5 fractions",
        2,
        11,
        2,
        "P450 BM3",
        "SDS-PAGE for BM3 fractions",
        False,
        ["Ade Okafor"],
        "",
    ),
    ("Dialysis overnight", 1, 18, 15, "P450 BM3", "P450 BM3 purification", False, [], ""),
    (
        "Purification week",
        11,
        None,
        5,
        "P450 BM3",
        "P450 BM3 purification",
        False,
        ["Priya Nair", "Ade Okafor"],
        "Batches 6 to 8.",
    ),
    ("Rotation student starts", 4, None, 1, "Rotation projects", None, False, ["Grace Ho"], ""),
    ("Plate reader service visit", 7, None, 1, None, None, True, [], "Lamp replacement."),
    ("Thanksgiving, lab closed", 21, None, 2, None, None, False, [], ""),
]


def plan_calendar(conn: psycopg.Connection, lab: UUID) -> None:
    """The lab's planned entries around today, as the admin; once per lab."""
    from datetime import timedelta
    from zoneinfo import ZoneInfo

    if _one(conn, "select count(*) from calendar_entries where lab_id = %s", (lab,)):
        return
    zone = ZoneInfo("America/New_York")
    today = datetime.now(zone).date()

    def ids(sql: str) -> dict[str, UUID]:
        return dict(conn.execute(sql, (lab,)).fetchall())

    experiments = ids("select name, id from experiments where lab_id = %s")
    people = ids("select display_name, id from people where lab_id = %s")
    protocols = ids(
        "select v.title, p.id from protocols p"
        " join protocol_versions v on v.id = p.current_version_id where p.lab_id = %s"
    )
    reader = _one(conn, "select id from instruments where lab_id = %s limit 1", (lab,))
    for title, offset, hour, length, exp, protocol, on_reader, who, notes in PLANS:
        day = today + timedelta(days=offset)
        if hour is None:
            span = (day, day + timedelta(days=length - 1), None, None)
        else:
            start = datetime(day.year, day.month, day.day, hour, tzinfo=zone)
            span = (None, None, start, start + timedelta(hours=length))
        conn.execute(
            "insert into calendar_entries (lab_id, title, notes, starts_on, ends_on, starts_at,"
            " ends_at, experiment_id, protocol_id, instrument_id, person_ids)"
            " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                lab,
                title,
                notes or None,
                *span,
                experiments.get(exp or ""),
                protocols.get(protocol or ""),
                reader if on_reader else None,
                [people[p] for p in who if p in people],
            ),
        )


def delete(rt: Runtime, admin: UUID) -> list[UUID]:
    """Deletes the admin's demo labs the way the app does: request_lab_deletion as the admin,
    then the worker's delete_lab for each of those labs and no other."""
    with rt.pool.connection() as conn:
        labs = demo_labs(conn, admin)
        for lab in labs:
            with conn.transaction(), as_user(conn, admin):
                conn.execute("select request_lab_deletion(%s, %s)", (lab, LAB_NAME))
    for lab in labs:
        deletion.delete_lab(rt, lab)
    return labs


@dataclass(frozen=True)
class Summary:
    rows: list[tuple[str, Any]]

    def text(self) -> str:
        width = max(len(k) for k, _ in self.rows)
        return "\n".join(f"{k:<{width}}  {v}" for k, v in self.rows)


def summary(conn: psycopg.Connection, lab: UUID) -> Summary:
    def q(sql: str) -> Any:
        return _one(conn, sql, {"lab": lab})

    def pairs(sql: str) -> str:
        rows = conn.execute(sql, {"lab": lab}).fetchall()
        return ", ".join(f"{a} {b}" for a, b in rows) or "none"

    failed = conn.execute(
        "select path, index_error from file_locations where lab_id = %(lab)s"
        " and index_state = 'failed' order by path",
        {"lab": lab},
    ).fetchall()
    rows: list[tuple[str, Any]] = [
        ("lab", lab),
        (
            "locations by source",
            pairs(
                "select s.kind, count(*) from file_locations fl"
                " join sources s on s.id = fl.source_id"
                " where fl.lab_id = %(lab)s group by 1 order by 1"
            ),
        ),
        (
            "locations by state",
            pairs(
                "select index_state, count(*) from file_locations where lab_id = %(lab)s"
                " group by 1 order by 1"
            ),
        ),
        (
            "unique files",
            q("select count(distinct sha256) from file_locations where lab_id = %(lab)s"),
        ),
        (
            "labels by status",
            pairs(
                "select status, count(*) from labels where lab_id = %(lab)s group by 1 order by 1"
            ),
        ),
        (
            "needs a look",
            q("select count(*) from labels where lab_id = %(lab)s and status = 'needs_look'"),
        ),
        ("experiments", q("select count(*) from experiments where lab_id = %(lab)s")),
        ("people", q("select count(*) from people where lab_id = %(lab)s")),
        (
            "protocols (versions)",
            q(
                "select count(*) || ' (' || (select count(*) from protocol_versions"
                " where lab_id = %(lab)s) || ')' from protocols where lab_id = %(lab)s"
            ),
        ),
        ("protocol files", q("select count(*) from protocol_files where lab_id = %(lab)s")),
        (
            "experiments on a protocol",
            q(
                "select count(*) from experiments"
                " where lab_id = %(lab)s and protocol_id is not null"
            ),
        ),
        (
            "instrument files",
            q(
                "select count(*) from file_locations fl"
                " join instruments i on i.source_id = fl.source_id"
                " where fl.lab_id = %(lab)s"
            ),
        ),
        ("uploads", q("select count(*) from uploads where lab_id = %(lab)s")),
        (
            "data tables",
            pairs("select state, count(*) from data_tables where lab_id = %(lab)s group by 1"),
        ),
        ("charts", q("select count(*) from charts where lab_id = %(lab)s")),
        (
            "videos",
            pairs(
                "select transcript || coalesce(': ' || transcript_error, ''), count(*) from videos"
                " where lab_id = %(lab)s group by 1"
            ),
        ),
        (
            "talk-throughs",
            pairs(
                "select t.draft || coalesce(': ' || coalesce(t.draft_error, fl.index_error), ''),"
                " count(*) from talk_throughs t join file_locations fl on fl.id = t.location_id"
                " where t.lab_id = %(lab)s group by 1"
            ),
        ),
        (
            "model calls",
            pairs(
                "select purpose || '/' || model, count(*) from model_calls where lab_id = %(lab)s"
                " group by 1 order by 1"
            ),
        ),
        (
            "model cost usd",
            q("select coalesce(sum(cost_usd), 0) from model_calls where lab_id = %(lab)s"),
        ),
    ]
    rows += [(f"failed {p}", e) for p, e in failed]
    return Summary(rows)
