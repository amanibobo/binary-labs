"""Running a file's protocol checks and keeping its flags (decisions.md, "checking results:
expected values and flags").

Triggers in 0018_checks.sql put a file in check_requests when its table is ready, its label
moves, or a protocol it's tied to changes. tend_checks queues run_checks for each file whose
request is newer than its last check. A run evaluates every check of every protocol tied to the
file (through its label's experiment, or a link on the protocol's page), replaces the file's
check_results, keeps a flag whose rule, value and cells haven't changed, clears one that no
longer holds and raises the new ones, all in one transaction. Running it again changes nothing.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from bl_worker import checks
from bl_worker.db import lab_lock
from bl_worker.previews import PreviewStore
from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

DUE = """
select lab_id, sha256 from check_requests
where checked_at is null or requested_at > checked_at
order by requested_at
"""

# Protocols whose current version has checks and that reach this file: through the experiment
# on its label (a label still waiting for a look doesn't count), or a link on the page.
APPLICABLE = """
with tied as (
  select e.protocol_id from labels l
  join experiments e on e.id = l.experiment_id and e.lab_id = l.lab_id
  where l.lab_id = %(lab)s and l.sha256 = %(sha)s and l.status <> 'needs_look'
    and e.protocol_id is not null
  union
  select f.protocol_id from protocol_files f where f.lab_id = %(lab)s and f.sha256 = %(sha)s
)
select p.id, v.id, v.expected_values
from tied t
join protocols p on p.id = t.protocol_id
join protocol_versions v on v.id = p.current_version_id
where p.archived_at is null and p.kind = 'protocol' and jsonb_array_length(v.expected_values) > 0
order by p.id
"""

# The files of the same experiment and day with a ready table, for a control check.
SAME_DAY = """
select t.sha256, t.storage_key from labels me
join labels l on l.lab_id = me.lab_id and l.experiment_id = me.experiment_id and l.date = me.date
  and l.sha256 <> me.sha256 and l.status <> 'needs_look'
join data_tables t on t.lab_id = l.lab_id and t.sha256 = l.sha256 and t.state = 'ready'
where me.lab_id = %(lab)s and me.sha256 = %(sha)s and me.status <> 'needs_look'
  and me.experiment_id is not null and me.date is not null
order by t.sha256
"""

CLEARED = {
    "passed": "It passes now.",
    "couldnt": "It can't be checked any more.",
    "gone": "The check no longer applies to this file.",
    "changed": "The rule, the value or the cells changed.",
}


@dataclass(frozen=True)
class Checked:
    protocol_id: UUID
    version_id: UUID
    check: dict[str, Any]
    result: checks.Result


def due(conn: psycopg.Connection) -> list[tuple[UUID, str]]:
    return [(r[0], r[1]) for r in conn.execute(DUE)]


def wanted(conn: psycopg.Connection, lab_id: UUID, sha256: str) -> bool:
    return (
        conn.execute(
            "select 1 from check_requests where lab_id = %s and sha256 = %s"
            " and (checked_at is null or requested_at > checked_at)",
            (lab_id, sha256),
        ).fetchone()
        is not None
    )


def _load(store: PreviewStore, sha256: str, key: str) -> checks.FileTables:
    return checks.file_tables(sha256, json.loads(store.get(key)))


def run_checks(rt: Runtime, lab_id: UUID, sha256: str) -> str | None:
    """Checks the file if it was asked for; None when nothing was waiting."""
    with rt.pool.connection() as conn, lab_lock(conn, lab_id, exclusive=False):
        row = conn.execute(
            "select r.requested_at, t.storage_key from check_requests r"
            " join data_tables t on t.lab_id = r.lab_id and t.sha256 = r.sha256"
            " where r.lab_id = %s and r.sha256 = %s"
            " and (r.checked_at is null or r.requested_at > r.checked_at)",
            (lab_id, sha256),
        ).fetchone()
        if row is None:
            return None
        asked: datetime = row[0]
        key: str | None = row[1]
        if key is None:
            # The table went back to waiting; its next ready asks again.
            _mark_checked(conn, lab_id, sha256, asked)
            return "no table"
        file = _load(rt.previews, sha256, key)

        def same_day() -> Iterator[checks.FileTables]:
            for other, other_key in conn.execute(SAME_DAY, {"lab": lab_id, "sha": sha256}):
                yield _load(rt.previews, other, other_key)

        siblings = checks.lazily(same_day)
        done = [
            Checked(p, v, check, checks.evaluate(check, file, siblings))
            for p, v, spec in conn.execute(APPLICABLE, {"lab": lab_id, "sha": sha256}).fetchall()
            for check in spec
        ]
        with conn.transaction():
            _record(conn, lab_id, sha256, done)
            _mark_checked(conn, lab_id, sha256, asked)
    counts = {o: sum(c.result.outcome == o for c in done) for o in ("passed", "flagged", "couldnt")}
    log.info("checks of %s: %s", sha256[:12], counts)
    return " ".join(f"{k} {v}" for k, v in counts.items())


def _mark_checked(conn: psycopg.Connection, lab_id: UUID, sha256: str, asked: datetime) -> None:
    conn.execute(
        "update check_requests set checked_at = %s where lab_id = %s and sha256 = %s",
        (asked, lab_id, sha256),
    )


def evidence(item: Checked) -> str:
    r = item.result
    cells = [
        None if c is None else [c.sha256, c.sheet, list(c.columns), c.spans()]
        for c in (r.source, r.control)
    ]
    body = json.dumps(
        {"check": item.check, "observed": r.observed, "unit": r.unit, "cells": cells},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(body.encode()).hexdigest()


def _multirange(cells: checks.Cells) -> str:
    return "{" + ",".join(f"[{a},{b})" for a, b in cells.spans()) + "}"


def _record(conn: psycopg.Connection, lab_id: UUID, sha256: str, done: list[Checked]) -> None:
    conn.execute(
        "delete from check_results where lab_id = %s and sha256 = %s"
        " and not (protocol_id::text || ' ' || check_id::text = any (%s))",
        (lab_id, sha256, [f"{c.protocol_id} {c.check['id']}" for c in done]),
    )
    for item in done:
        r = item.result
        conn.execute(
            "insert into check_results (lab_id, sha256, protocol_id, protocol_version_id, check_id,"
            " kind, outcome, observed, unit, reason)"
            " values (%(lab)s, %(sha)s, %(p)s, %(v)s, %(c)s, %(kind)s, %(outcome)s, %(observed)s,"
            " %(unit)s, %(reason)s)"
            " on conflict (lab_id, sha256, protocol_id, check_id) do update set"
            " protocol_version_id = excluded.protocol_version_id, kind = excluded.kind,"
            " outcome = excluded.outcome, observed = excluded.observed, unit = excluded.unit,"
            " reason = excluded.reason, checked_at = now()",
            {
                "lab": lab_id,
                "sha": sha256,
                "p": item.protocol_id,
                "v": item.version_id,
                "c": UUID(item.check["id"]),
                "kind": item.check["kind"],
                "outcome": r.outcome,
                "observed": r.observed,
                "unit": r.unit,
                "reason": r.reason,
            },
        )

    open_flags = {
        (row[1], row[2]): (row[0], row[3])
        for row in conn.execute(
            "select id, protocol_id, check_id, evidence from flags"
            " where lab_id = %s and sha256 = %s and cleared_at is null",
            (lab_id, sha256),
        )
    }
    outcomes = {(c.protocol_id, UUID(c.check["id"])): c for c in done}
    for key, (flag_id, digest) in open_flags.items():
        item = outcomes.get(key)
        if item is None:
            _clear(conn, flag_id, CLEARED["gone"])
        elif item.result.outcome != "flagged":
            _clear(conn, flag_id, CLEARED[item.result.outcome])
        elif digest != evidence(item):
            _clear(conn, flag_id, CLEARED["changed"])
    kept = {
        key
        for key, (_, digest) in open_flags.items()
        if key in outcomes
        and outcomes[key].result.outcome == "flagged"
        and digest == evidence(outcomes[key])
    }
    for key, item in outcomes.items():
        if item.result.outcome == "flagged" and key not in kept:
            _raise(conn, lab_id, sha256, item)


def _clear(conn: psycopg.Connection, flag_id: UUID, reason: str) -> None:
    conn.execute(
        "update flags set cleared_at = now(), cleared_reason = %s where id = %s", (reason, flag_id)
    )


def _raise(conn: psycopg.Connection, lab_id: UUID, sha256: str, item: Checked) -> None:
    r = item.result
    assert r.source is not None and r.observed is not None
    control = r.control
    conn.execute(
        "insert into flags (lab_id, sha256, protocol_id, protocol_version_id, check_id, kind,"
        " observed, expected, unit, source_sheet, source_columns, source_rows, control_sha256,"
        " control_sheet, control_columns, control_rows, evidence)"
        " values (%(lab)s, %(sha)s, %(p)s, %(v)s, %(c)s, %(kind)s, %(observed)s, %(expected)s,"
        " %(unit)s, %(sheet)s, %(columns)s, %(rows)s::int4multirange, %(csha)s, %(csheet)s,"
        " %(ccolumns)s, %(crows)s::int4multirange, %(evidence)s)",
        {
            "lab": lab_id,
            "sha": sha256,
            "p": item.protocol_id,
            "v": item.version_id,
            "c": UUID(item.check["id"]),
            "kind": item.check["kind"],
            "observed": r.observed,
            "expected": Jsonb(item.check["range"]),
            "unit": r.unit,
            "sheet": r.source.sheet,
            "columns": list(r.source.columns),
            "rows": _multirange(r.source),
            "csha": control.sha256 if control else None,
            "csheet": control.sheet if control else None,
            "ccolumns": list(control.columns) if control else None,
            "crows": _multirange(control) if control else None,
            "evidence": evidence(item),
        },
    )
