"""Short titles, enforced at the boundary rather than trusted to the prompt: about 60
characters, the subject plus the one detail that sets a file apart, no date (the date is its
own field) and no filler. When two files in a lab would share a title, the differing detail
("plate 2", "plate 3") is added instead of lengthening both. Pure."""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import PurePosixPath

from bl_worker.labels.domain import Condition, norm

MAX_TITLE = 60

_MONTH = (
    r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?"
    r"|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
)
_DATES = [
    re.compile(r"\b(?:19|20)\d\d[-_./](?:0?[1-9]|1[0-2])[-_./](?:0?[1-9]|[12]\d|3[01])\b"),
    re.compile(r"\b(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:19|20)?\d\d\b"),
    re.compile(rf"\b{_MONTH}\s+\d{{1,2}}(?:st|nd|rd|th)?,?(?:\s+(?:19|20)\d\d)?\b", re.I),
    re.compile(rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s+{_MONTH},?(?:\s+(?:19|20)\d\d)?\b", re.I),
    re.compile(rf"\b{_MONTH}\s+(?:19|20)\d\d\b", re.I),
]
_FILLER = re.compile(
    r"^(?:(?:notes?|results?|data|summary|report|scan|photo|image|picture|overview|record)"
    r"\s+(?:on|of|from|for|about)\s+(?:the\s+)?|(?:notes?|results?)\s*:\s*)",
    re.I,
)
_DANGLING = {"and", "of", "with", "for", "in", "on", "the", "a", "an", "at", "to", "from", "-"}
_EDGES = " \t-–—,:;·|/"


def tidy_title(text: str | None) -> str | None:
    """The model's title with dates, filler and pipes taken out, cut to MAX_TITLE at a word."""
    if not text:
        return None
    t = " ".join(text.split())
    if "|" in t:
        t = " ".join(part.strip() for part in t.split("|") if part.strip())
    undated = t
    for pattern in _DATES:
        undated = pattern.sub(" ", undated)
    if undated != t:
        # "DSF plate read, 2026-10-14 run" loses its date and the word the date qualified.
        undated = re.sub(r"[\s,]+(?:run|read|batch|plate|page)\s*$", "", undated, flags=re.I)
    t = re.sub(r"\(\s*\)", " ", undated)
    t = " ".join(t.split()).strip(_EDGES)
    t = _FILLER.sub("", t).strip(_EDGES)
    t = shorten(t, MAX_TITLE)
    if not t:
        return None
    return t[0].upper() + t[1:]


def shorten(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    words = text[: limit + 1].split()
    if len(text) > limit + 1 and text[limit + 1] != " ":
        words = words[:-1]
    while words and (words[-1].lower() in _DANGLING or len(" ".join(words)) > limit):
        words.pop()
    return " ".join(words).strip(_EDGES)


# A word that names a member of a series, then its number: plate 3, run 2, page 07, rep 1.
_SERIES = re.compile(
    r"\b(plate|run|batch|read|rep|replicate|page|day|lane|gel|blot|trial|attempt|set|part"
    r"|sample|well|week|v|version|round|shot|image|img|scan|tube|flask|dish)\s?(\d{1,4})\b"
)


def _series_in(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for word, number in _SERIES.findall(norm(text)):
        found.setdefault(word, str(int(number)))
    return found


def _series(path: str) -> dict[str, str]:
    return _series_in(PurePosixPath(path).stem)


def _condition_values(conditions: Sequence[Condition]) -> dict[str, str]:
    return {
        c.what.lower(): " ".join(x for x in (c.value, c.unit) if x)
        for c in conditions
        if c.value and "[unclear]" not in c.value
    }


def differing_detail(
    path: str,
    other_path: str,
    conditions: Sequence[Condition] = (),
    other_conditions: Sequence[Condition] = (),
) -> tuple[str, str] | None:
    """The one detail that tells two files apart, for each of them: their series numbers
    ("plate 2", "plate 3"), else a condition with different values, else their folders."""
    mine, theirs = _series(path), _series(other_path)
    for word in [*mine, *theirs]:
        if mine.get(word) != theirs.get(word):
            label = "image" if word == "img" else word
            return (
                f"{label} {mine[word]}" if word in mine else "",
                f"{label} {theirs[word]}" if word in theirs else "",
            )
    a, b = _condition_values(conditions), _condition_values(other_conditions)
    for what in a:
        if what in b and a[what] != b[what]:
            return f"{what} {a[what]}", f"{what} {b[what]}"
    folder, other_folder = PurePosixPath(path).parent.name, PurePosixPath(other_path).parent.name
    if folder and other_folder and folder.lower() != other_folder.lower():
        return " ".join(norm(folder).split()[:3]), " ".join(norm(other_folder).split()[:3])
    return None


def with_detail(title: str, detail: str) -> str:
    """The title with its detail at the end, the title cut so the whole fits MAX_TITLE."""
    if not detail or norm(detail) in norm(title):
        return title
    base = shorten(title, MAX_TITLE - len(detail) - 2)
    return f"{base}, {detail}" if base else shorten(detail, MAX_TITLE)


# Series words a file name numbers that a title should always carry: "run 1", not just "run".
_KEPT_SERIES = ("run", "read", "plate", "batch", "rep", "replicate")


def missing_series(path: str, title: str) -> str | None:
    """The run, read, plate or batch number the file's name gives and its title leaves out."""
    for word, number in _series(path).items():
        if word in _KEPT_SERIES and _series_in(title).get(word) != number:
            return f"{word} {number}"
    return None


def same_title(a: str | None, b: str | None) -> bool:
    return a is not None and b is not None and norm(a) == norm(b)
