from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import IntEnum, StrEnum
from pathlib import PurePosixPath
from typing import Any
from uuid import UUID

from bl_worker.domain import FileKind


class LabelStatus(StrEnum):
    SUGGESTED = "suggested"
    CHECK = "check"
    NEEDS_LOOK = "needs_look"
    ACCEPTED = "accepted"
    CORRECTED = "corrected"


# Labels a person has confirmed or written; the worker never overwrites them.
HUMAN_STATUSES = frozenset({LabelStatus.ACCEPTED, LabelStatus.CORRECTED})


class RuleKind(StrEnum):
    FOLDER_EXPERIMENT = "folder_experiment"
    FOLDER_PERSON = "folder_person"
    NAME_TEMPLATE = "name_template"


class Strength(IntEnum):
    WEAK = 1  # the file's modified time, a guess from the file kind
    MEDIUM = 2  # a hint in the file name
    STRONG = 3  # EXIF, a folder, a full date in the name, an instrument signature
    TAUGHT = 4  # a rule learned from a person's correction


@dataclass(frozen=True)
class Experiment:
    id: UUID
    name: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class Person:
    id: UUID
    name: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class LabRule:
    kind: RuleKind
    folder: str
    name_skeleton: str = ""
    template: str | None = None
    experiment_id: UUID | None = None
    person_id: UUID | None = None


@dataclass(frozen=True)
class Example:
    """A past correction, shown to the model as a few-shot example."""

    path: str
    before: dict[str, Any]
    after: dict[str, Any]


@dataclass(frozen=True)
class LabContext:
    experiments: tuple[Experiment, ...] = ()
    people: tuple[Person, ...] = ()
    rules: tuple[LabRule, ...] = ()
    examples: tuple[Example, ...] = ()

    def experiment(self, id: UUID | None) -> Experiment | None:
        return next((e for e in self.experiments if e.id == id), None)

    def person(self, id: UUID | None) -> Person | None:
        return next((p for p in self.people if p.id == id), None)

    def find_experiment(self, text: str | None) -> Experiment | None:
        return _find(self.experiments, text)

    def find_person(self, text: str | None) -> Person | None:
        return _find(self.people, text)


def _find[T: (Experiment, Person)](items: tuple[T, ...], text: str | None) -> T | None:
    if not text:
        return None
    key = norm(text)
    exact = [i for i in items if norm(i.name) == key]
    if exact:
        return exact[0]
    by_alias = [i for i in items if key in {norm(a) for a in i.aliases}]
    return by_alias[0] if len(by_alias) == 1 else None


@dataclass(frozen=True)
class FileInfo:
    """One blob in one lab, as labeling sees it."""

    lab_id: UUID
    sha256: str
    file_kind: FileKind
    mime: str
    # Live paths, most recently modified first.
    paths: tuple[str, ...]
    modified_at: datetime
    text: str = ""
    meta: dict[str, Any] = field(default_factory=dict)
    caption: str | None = None
    # False when no extractor could read the file: an unknown format or a broken one.
    readable: bool = True

    @property
    def path(self) -> str:
        return self.paths[0]

    @property
    def name(self) -> str:
        return PurePosixPath(self.path).name


@dataclass(frozen=True)
class Fact[T]:
    value: T
    source: str
    strength: Strength


@dataclass(frozen=True)
class Proposal:
    """A model's label after parsing, with names resolved against the lab's lists."""

    clean_name: str | None
    date: date | None
    experiment: Experiment | None
    person: Person | None
    instrument: str | None
    tags: tuple[str, ...]
    confidence: float
    reason: str
    model: str


@dataclass(frozen=True)
class Draft:
    """The label the worker writes."""

    status: LabelStatus
    clean_name: str | None
    date: date | None
    experiment_id: UUID | None
    person_id: UUID | None
    instrument: str | None
    tags: tuple[str, ...]
    confidence: float
    source: str
    reason: str | None


SEPARATORS = re.compile(r"[_./\\\-\s]+")
ALPHA_DIGIT = re.compile(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])")


def norm(text: str) -> str:
    """Lowercase words with separators spaced out and letters split from digits:
    "screen_plate07" and "Screen plate 07" both become "screen plate 07"."""
    return " ".join(ALPHA_DIGIT.sub(" ", SEPARATORS.sub(" ", text.lower())).split())


def contains_words(haystack: str, needle: str) -> bool:
    n = norm(needle)
    return bool(n) and f" {n} " in f" {norm(haystack)} "


def folder_of(path: str) -> str:
    parent = str(PurePosixPath(path).parent)
    return parent.lower()


def under(path: str, folder: str) -> bool:
    return folder == "/" or path.lower().startswith(folder.rstrip("/") + "/")
