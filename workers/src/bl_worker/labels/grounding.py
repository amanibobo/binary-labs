"""Never inventing a number. A value in a condition or the summary that isn't in what the file
shows (its text, its image description, its path) becomes [unclear], and whatever was unclear
is named so the label asks for a look. Pure."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import replace

from bl_worker.labels.domain import UNCLEAR, Condition

_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
# Counts a careful reader works out rather than reads ("triplicate" is 3, five
# concentrations is 5) are let through up to this.
SMALL_COUNT = 12
# A label with something unclear is at most this sure, so it always says Check this.
UNCLEAR_CAP = 0.84
MAX_UNCLEAR = 6


def _key(number: str) -> str:
    n = number.replace(",", ".")
    if "." in n:
        n = n.rstrip("0").rstrip(".")
    return n.lstrip("0") or "0"


def numbers_in(text: str) -> set[str]:
    return {_key(m) for m in _NUMBER.findall(text)}


def _grounded(number: str, seen: set[str]) -> bool:
    key = _key(number)
    if key in seen:
        return True
    return "." not in key and int(key) <= SMALL_COUNT


def ground_text(text: str, seen: set[str]) -> tuple[str, bool]:
    """The text with each number the source doesn't show replaced by [unclear]."""
    changed = False

    def swap(m: re.Match[str]) -> str:
        nonlocal changed
        if _grounded(m[0], seen):
            return m[0]
        changed = True
        return UNCLEAR

    return _NUMBER.sub(swap, text), changed


def ground_conditions(
    conditions: Iterable[Condition], source: str
) -> tuple[tuple[Condition, ...], tuple[str, ...]]:
    """Conditions with ungrounded numbers swapped for [unclear], and what each swap hid."""
    seen = numbers_in(source)
    out: list[Condition] = []
    notes: list[str] = []
    for c in conditions:
        value = c.value
        if value is not None:
            value, changed = ground_text(value, seen)
            if changed:
                notes.append(f"{c.what}: the value isn't clear in the file")
        out.append(replace(c, value=value))
    return tuple(out), tuple(notes)


def has_unclear(*texts: str | None) -> bool:
    return any(t is not None and UNCLEAR in t for t in texts)


def merge_unclear(
    named: Iterable[str], found: Iterable[str], conditions: Iterable[Condition]
) -> tuple[str, ...]:
    """What was unclear, as the model named it, then what the checks found, then any
    [unclear] value nobody named yet."""
    out = [n for n in (" ".join(x.split())[:200] for x in [*named, *found]) if n]
    for c in conditions:
        if (
            c.value is not None
            and UNCLEAR in c.value
            and not any(c.what.lower() in n.lower() for n in out)
        ):
            out.append(f"{c.what} isn't clear in the file")
    return tuple(dict.fromkeys(out))[:MAX_UNCLEAR]
