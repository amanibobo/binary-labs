"""Scores stored labels against hand-written ones (evals/labels_expected.json)."""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
from statistics import median
from typing import Any
from uuid import UUID

import psycopg

from bl_worker.config import WORKERS_DIR
from bl_worker.labels.domain import contains_words

EXPECTED = WORKERS_DIR / "evals" / "labels_expected.json"
FIELDS = ("name", "date", "experiment", "person", "instrument")


def load_expected(path: Path = EXPECTED) -> dict[str, Any]:
    return json.loads(path.read_text())


def _any(expected: Any) -> list[Any]:
    return expected if isinstance(expected, list) else [expected]


def name_ok(terms: list[Any], name: str | None) -> bool:
    if not name:
        return False
    return all(any(contains_words(name, t) for t in _any(term)) for term in terms)


@dataclass
class Report:
    files: int = 0
    correct: Counter[str] = field(default_factory=Counter)
    accepted: int = 0
    statuses: Counter[str] = field(default_factory=Counter)
    misses: list[tuple[str, str, Any, Any]] = field(default_factory=list)
    cost_usd: Decimal = Decimal(0)
    calls: Counter[str] = field(default_factory=Counter)
    title_lengths: list[int] = field(default_factory=list)
    outcomes: int = 0
    outcomes_right: int = 0

    def text(self) -> str:
        n = max(self.files, 1)
        lines = [f"files: {self.files}"]
        lines += [
            f"{f:<11} {self.correct[f] / n:6.1%}  ({self.correct[f]}/{self.files})" for f in FIELDS
        ]
        lines.append(
            f"accepted without edits: {self.accepted / n:.1%} ({self.accepted}/{self.files})"
        )
        if self.outcomes:
            lines.append(f"outcome: {self.outcomes_right}/{self.outcomes} right")
        if self.title_lengths:
            lines.append(
                f"title length: median {median(self.title_lengths):.0f},"
                f" max {max(self.title_lengths)} characters"
                f" ({sum(t > 60 for t in self.title_lengths)} over 60)"
            )
        lines.append("statuses: " + ", ".join(f"{s} {c}" for s, c in sorted(self.statuses.items())))
        lines.append(
            "model calls: "
            + (", ".join(f"{k} {v}" for k, v in sorted(self.calls.items())) or "none")
        )
        lines.append(f"cost: ${self.cost_usd:.4f} total, ${self.cost_usd / n:.5f} per file")
        lines.append("confusions:")
        lines += [
            f"  {path}  {fld}: expected {exp!r}, got {got!r}" for path, fld, exp, got in self.misses
        ]
        return "\n".join(lines)


def score(conn: psycopg.Connection, lab_id: UUID, expected: dict[str, Any]) -> Report:
    report = Report()
    for item in expected["files"]:
        rows = conn.execute(
            """
            select fl.sha256, fl.modified_at::date, l.status, l.clean_name, l.date, e.name,
              to_jsonb(l) ->> 'outcome',
              p.display_name, l.instrument
            from file_locations fl
            left join labels l on l.lab_id = fl.lab_id and l.sha256 = fl.sha256
            left join experiments e on e.id = l.experiment_id
            left join people p on p.id = l.person_id
            where fl.lab_id = %s and fl.path = any(%s) and fl.deleted_at is null
            """,
            (lab_id, item["paths"]),
        ).fetchall()
        path = item["paths"][0]
        if not rows:
            report.misses.append((path, "file", "indexed", None))
            continue
        report.files += 1
        _, _, status, name, day, experiment, outcome, person, instrument = rows[0]
        modified = {r[1] for r in rows}
        report.statuses[status or "none"] += 1
        want_dates = _any(item["date"])
        got = {
            "name": name,
            "date": day.isoformat() if isinstance(day, date) else None,
            "experiment": experiment,
            "person": person,
            "instrument": instrument,
        }
        ok = {
            "name": name_ok(item["name_terms"], name),
            "date": any(
                (w == "modified" and day in modified) or (w is not None and w == got["date"])
                for w in want_dates
            ),
            "experiment": experiment in _any(item["experiment"]),
            "person": person in _any(item["person"]),
            "instrument": instrument in _any(item["instrument"]),
        }
        for fld in FIELDS:
            if ok[fld]:
                report.correct[fld] += 1
            else:
                want = item["name_terms"] if fld == "name" else item[fld]
                report.misses.append((path, fld, want, got[fld]))
        if all(ok.values()) and status in ("suggested", "check", "accepted"):
            report.accepted += 1
        if name:
            report.title_lengths.append(len(name))
        if "outcome" in item:
            report.outcomes += 1
            if outcome in _any(item["outcome"]):
                report.outcomes_right += 1
            else:
                report.misses.append((path, "outcome", item["outcome"], outcome))
    for purpose, model, calls, cost in conn.execute(
        "select purpose, model, count(*), sum(cost_usd) from model_calls where lab_id = %s"
        " group by 1, 2",
        (lab_id,),
    ):
        report.calls[f"{purpose}/{model}"] = calls
        report.cost_usd += cost
    return report


def seed_lab(conn: psycopg.Connection, lab_id: UUID, expected: dict[str, Any]) -> None:
    """The lab's experiments and people, as an admin would type them into Settings."""
    for e in expected["lab"]["experiments"]:
        conn.execute(
            "insert into experiments (lab_id, name, aliases) values (%s, %s, %s)"
            " on conflict do nothing",
            (lab_id, e["name"], e["aliases"]),
        )
    for p in expected["lab"]["people"]:
        conn.execute(
            "insert into people (lab_id, display_name, aliases) values (%s, %s, %s)"
            " on conflict do nothing",
            (lab_id, p["name"], p["aliases"]),
        )


FINDABILITY = WORKERS_DIR / "evals" / "findability.json"
TOP = 3


@dataclass
class Findability:
    queries: int = 0
    found: int = 0
    misses: list[tuple[str, str, list[str]]] = field(default_factory=list)

    def text(self) -> str:
        n = max(self.queries, 1)
        share = f"{self.found / n:.1%}"
        lines = [f"findability: {self.found}/{self.queries} in the top {TOP} ({share})"]
        lines += [f"  miss: {q!r} for {p}; top: {top}" for q, p, top in self.misses]
        return "\n".join(lines)


def findability(
    conn: psycopg.Connection,
    lab_id: UUID,
    embed: Callable[[str], list[float]] | None,
    path: Path = FINDABILITY,
) -> Findability:
    """How many of evals/findability.json's searches put their file, or the note it is a page
    of, in the top 3, through search_files as the web app calls it."""
    report = Findability()
    for item in json.loads(path.read_text())["queries"]:
        row = conn.execute(
            "select sha256 from file_locations where lab_id = %s and path = %s"
            " and deleted_at is null",
            (lab_id, item["path"]),
        ).fetchone()
        report.queries += 1
        if row is None:
            report.misses.append((item["query"], item["path"], ["not indexed"]))
            continue
        target = row[0]
        vector = embed(item["query"]) if embed else None
        hits = conn.execute(
            "select sha256 from search_files(%s, %s, %s::vector, null, null, null, null, %s)",
            (lab_id, item["query"], vector, TOP),
        ).fetchall()
        shas = [h[0] for h in hits]
        notes = _note_pages(conn, lab_id, shas)
        if any(target == s or target in notes.get(s, ()) for s in shas):
            report.found += 1
        else:
            names = [_title(conn, lab_id, s) for s in shas]
            report.misses.append((item["query"], item["path"], names))
    return report


def _note_pages(conn: psycopg.Connection, lab_id: UUID, shas: list[str]) -> dict[str, set[str]]:
    exists = conn.execute("select to_regclass('note_pages') is not null").fetchone()
    if not exists or not exists[0]:
        return {}
    out: dict[str, set[str]] = {}
    for sha in shas:
        rows = conn.execute(
            "select p.sha256 from note_pages me join note_pages p on p.note_id = me.note_id"
            " and p.live where me.lab_id = %s and me.sha256 = %s and me.live",
            (lab_id, sha),
        ).fetchall()
        out[sha] = {r[0] for r in rows}
    return out


def _title(conn: psycopg.Connection, lab_id: UUID, sha: str) -> str:
    row = conn.execute(
        "select coalesce(l.clean_name, (select fl.path from file_locations fl"
        " where fl.lab_id = %s and fl.sha256 = %s limit 1))"
        " from (select 1) x left join labels l on l.lab_id = %s and l.sha256 = %s",
        (lab_id, sha, lab_id, sha),
    ).fetchone()
    return row[0] if row and row[0] else sha[:12]
