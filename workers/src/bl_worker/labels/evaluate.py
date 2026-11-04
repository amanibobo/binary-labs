"""Scores stored labels against hand-written ones (evals/labels_expected.json)."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
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

    def text(self) -> str:
        n = max(self.files, 1)
        lines = [f"files: {self.files}"]
        lines += [
            f"{f:<11} {self.correct[f] / n:6.1%}  ({self.correct[f]}/{self.files})" for f in FIELDS
        ]
        lines.append(
            f"accepted without edits: {self.accepted / n:.1%} ({self.accepted}/{self.files})"
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
        _, _, status, name, day, experiment, person, instrument = rows[0]
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
