"""Learning from corrections: a correction that shows a simple pattern (this folder means
this experiment or person, files named like this are named like that) becomes a rule for
the lab, and similar files are re-suggested under it."""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import timedelta
from pathlib import PurePosixPath
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from bl_worker.labels.domain import LabRule, RuleKind, folder_of, under
from bl_worker.labels.job import label_blob
from bl_worker.labels.tier1 import make_template, name_skeleton
from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

# Undo lives in a snackbar for a few seconds; learning waits it out so an undone
# correction is never learned and then unlearned.
SETTLE = timedelta(seconds=15)


def derive_rules(before: dict[str, Any], after: dict[str, Any], path: str) -> list[LabRule]:
    folder = folder_of(path)
    rules = []
    if folder != "/":
        exp = after.get("experiment_id")
        if exp and exp != before.get("experiment_id"):
            rules.append(LabRule(RuleKind.FOLDER_EXPERIMENT, folder, experiment_id=UUID(exp)))
        person = after.get("person_id")
        if person and person != before.get("person_id"):
            rules.append(LabRule(RuleKind.FOLDER_PERSON, folder, person_id=UUID(person)))
    name = after.get("clean_name")
    file_name = PurePosixPath(path).name
    if name and name != before.get("clean_name"):
        template = make_template(file_name, name)
        if template is not None:
            rules.append(
                LabRule(RuleKind.NAME_TEMPLATE, folder, name_skeleton(file_name), template)
            )
    return rules


def _similar(conn: psycopg.Connection, lab_id: UUID, rule: LabRule, skip: str) -> set[str]:
    rows = conn.execute(
        "select sha256, path from file_locations"
        " where lab_id = %s and sha256 is not null and sha256 <> %s and deleted_at is null",
        (lab_id, skip),
    ).fetchall()
    if rule.kind == RuleKind.NAME_TEMPLATE:
        return {
            sha
            for sha, path in rows
            if folder_of(path) == rule.folder
            and name_skeleton(PurePosixPath(path).name) == rule.name_skeleton
        }
    return {sha for sha, path in rows if under(path, rule.folder)}


UPSERT_RULE = """
insert into label_rules (lab_id, kind, folder, name_skeleton, template, experiment_id,
  person_id, correction_id)
values (%s, %s, %s, %s, %s, %s, %s, %s)
on conflict (lab_id, kind, folder, name_skeleton) do update set
  template = excluded.template, experiment_id = excluded.experiment_id,
  person_id = excluded.person_id, correction_id = excluded.correction_id, created_at = now()
"""


def _rule_json(rule: LabRule) -> dict[str, Any]:
    return {k: str(v) if isinstance(v, UUID) else v for k, v in asdict(rule).items() if v}


def learn_pending(rt: Runtime, *, settle: timedelta = SETTLE) -> int:
    """Learns from every settled correction not yet learned; returns how many it handled."""
    with rt.pool.connection() as conn:
        pending = conn.execute(
            "select c.id, c.lab_id, c.sha256, c.before, c.after, c.undoes from corrections c"
            " join labs l on l.id = c.lab_id and l.deletion_requested_at is null"
            " where c.learned_at is null and c.at <= now() - %s order by c.id",
            (settle,),
        ).fetchall()
    for cid, lab_id, sha, before, after, undoes in pending:
        resuggest: set[str] = set()
        with rt.pool.connection() as conn, conn.transaction():
            if undoes is not None:
                rules = [
                    LabRule(RuleKind(k), folder, skeleton)
                    for k, folder, skeleton in conn.execute(
                        "delete from label_rules where correction_id = %s"
                        " returning kind, folder, name_skeleton",
                        (undoes,),
                    )
                ]
                learned: list[LabRule] = []
            elif conn.execute("select 1 from corrections where undoes = %s", (cid,)).fetchone():
                rules, learned = [], []
            else:
                path = conn.execute(
                    "select path from file_locations where lab_id = %s and sha256 = %s"
                    " and deleted_at is null order by modified_at desc limit 1",
                    (lab_id, sha),
                ).fetchone()
                learned = derive_rules(before, after, path[0]) if path else []
                for r in learned:
                    conn.execute(
                        UPSERT_RULE,
                        (
                            lab_id,
                            r.kind,
                            r.folder,
                            r.name_skeleton,
                            r.template,
                            r.experiment_id,
                            r.person_id,
                            cid,
                        ),
                    )
                rules = learned
            for r in rules:
                resuggest |= _similar(conn, lab_id, r, sha)
            conn.execute(
                "update corrections set learned_at = now(), rule_learned = %s where id = %s",
                (Jsonb([_rule_json(r) for r in learned]) if learned else None, cid),
            )
        for other in sorted(resuggest):
            label_blob(rt, lab_id, other, call_models=False)
        if learned or resuggest:
            log.info(
                "correction %s: %d rules, %d similar files re-suggested",
                cid,
                len(learned),
                len(resuggest),
            )
    return len(pending)
