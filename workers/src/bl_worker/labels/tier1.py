"""Tier 1: facts from names, folders, EXIF and headers, at no model cost.

Each rule in RULES reads a file and the lab's context and yields findings. For each field
the strongest finding wins; two different values at the same top strength are a conflict.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date
from pathlib import PurePosixPath
from typing import Any, Literal

from bl_worker.domain import FileKind
from bl_worker.labels.domain import (
    Experiment,
    Fact,
    FileInfo,
    LabContext,
    Person,
    RuleKind,
    Strength,
    contains_words,
    folder_of,
    norm,
    under,
)

Field = Literal["date", "experiment", "person", "instrument", "what", "name", "tag"]
Finding = tuple[Field, Fact[Any]]
Rule = Callable[[FileInfo, LabContext], Iterable[Finding]]


def _date(y: int, m: int, d: int) -> date | None:
    try:
        found = date(y, m, d)
    except ValueError:
        return None
    return found if 2000 <= found.year <= 2099 else None


# (pattern, how to read it, strength). Full dates first; 141026 reads as 14 Oct 2026, the
# lab's habit; "10-21" alone takes its year from the file's modified time.
DATE_PATTERNS: list[
    tuple[re.Pattern[str], Callable[[re.Match[str], int], date | None], Strength]
] = [
    (
        re.compile(r"(?<!\d)(20\d\d)[-_.]?(\d\d)[-_.]?(\d\d)(?!\d)"),
        lambda m, _y: _date(int(m[1]), int(m[2]), int(m[3])),
        Strength.STRONG,
    ),
    (
        re.compile(r"(?<!\d)(\d\d)(\d\d)(\d\d)(?!\d)"),
        lambda m, _y: _date(2000 + int(m[3]), int(m[2]), int(m[1])),
        Strength.STRONG,
    ),
    (
        re.compile(r"(?<![\d-])(\d{1,2})-(\d{1,2})(?![\d-])"),
        lambda m, y: _date(y, int(m[1]), int(m[2])),
        Strength.MEDIUM,
    ),
]


def _dates_in(text: str, year: int) -> Iterable[tuple[date, Strength]]:
    for pattern, read, strength in DATE_PATTERNS:
        for m in pattern.finditer(text):
            found = read(m, year)
            if found is not None:
                yield found, strength
                return


def exif_date(f: FileInfo, _ctx: LabContext) -> Iterable[Finding]:
    exif = f.meta.get("exif", {})
    for tag in ("DateTimeOriginal", "DateTime"):
        m = re.match(r"(\d{4}):(\d\d):(\d\d)", exif.get(tag, ""))
        if m and (found := _date(int(m[1]), int(m[2]), int(m[3]))):
            yield "date", Fact(found, "EXIF capture time", Strength.STRONG)
            return


def name_date(f: FileInfo, _ctx: LabContext) -> Iterable[Finding]:
    for path in f.paths:
        stem = PurePosixPath(path).stem
        for found, strength in _dates_in(stem, f.modified_at.year):
            yield "date", Fact(found, f"file name {stem!r}", strength)


def folder_date(f: FileInfo, _ctx: LabContext) -> Iterable[Finding]:
    for path in f.paths:
        for segment in PurePosixPath(path).parent.parts[1:]:
            for found, _ in _dates_in(segment, f.modified_at.year):
                yield "date", Fact(found, f"folder {segment!r}", Strength.STRONG)


def modified_date(f: FileInfo, _ctx: LabContext) -> Iterable[Finding]:
    yield "date", Fact(f.modified_at.date(), "file modified time", Strength.WEAK)


def _folder_text(path: str) -> str:
    return " / ".join(PurePosixPath(path).parent.parts[1:])


def _names(item: Experiment | Person) -> tuple[str, ...]:
    return (item.name, *item.aliases)


def folder_experiment(f: FileInfo, ctx: LabContext) -> Iterable[Finding]:
    for path in f.paths:
        # The whole folder path too, so "P450 batch 3" matches /P450/batch3/.
        folders = _folder_text(path)
        for e in ctx.experiments:
            if any(contains_words(folders, n) for n in _names(e)):
                yield "experiment", Fact(e, f"folder {folders!r}", Strength.STRONG)


def name_experiment(f: FileInfo, ctx: LabContext) -> Iterable[Finding]:
    stem = PurePosixPath(f.path).stem
    for e in ctx.experiments:
        if any(contains_words(stem, n) for n in _names(e)):
            yield "experiment", Fact(e, f"file name {stem!r}", Strength.MEDIUM)


def _is_initials(alias: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]{2,3}", alias))


def _person_in(text: str, p: Person) -> bool:
    words = re.split(r"[^A-Za-z]+", text)
    for alias in _names(p):
        # Initials match only as their own upper-case word; "ab" inside "lab" is no one.
        if _is_initials(alias):
            if alias in words:
                return True
        elif contains_words(text, alias):
            return True
    return False


def folder_person(f: FileInfo, ctx: LabContext) -> Iterable[Finding]:
    for path in f.paths:
        for segment in PurePosixPath(path).parent.parts[1:]:
            for p in ctx.people:
                if _person_in(segment, p):
                    yield "person", Fact(p, f"folder {segment!r}", Strength.STRONG)


def name_person(f: FileInfo, ctx: LabContext) -> Iterable[Finding]:
    stem = PurePosixPath(f.path).stem
    for p in ctx.people:
        if _person_in(stem, p):
            yield "person", Fact(p, f"file name {stem!r}", Strength.MEDIUM)


def taught_rules(f: FileInfo, ctx: LabContext) -> Iterable[Finding]:
    """Rules learned from corrections. The deepest folder wins, so a correction in a
    subfolder can override one made higher up."""
    by_depth = sorted(ctx.rules, key=lambda r: r.folder.count("/"), reverse=True)
    for rule in by_depth:
        paths = [p for p in f.paths if under(p, rule.folder)]
        if not paths:
            continue
        source = f"taught for {rule.folder}"
        match rule.kind:
            case RuleKind.FOLDER_EXPERIMENT:
                if e := ctx.experiment(rule.experiment_id):
                    yield "experiment", Fact(e, source, Strength.TAUGHT)
            case RuleKind.FOLDER_PERSON:
                if p := ctx.person(rule.person_id):
                    yield "person", Fact(p, source, Strength.TAUGHT)
            case RuleKind.NAME_TEMPLATE:
                for path in paths:
                    if folder_of(path) != rule.folder or rule.template is None:
                        continue
                    name = fill_template(
                        PurePosixPath(path).name, rule.name_skeleton, rule.template
                    )
                    if name:
                        yield (
                            "name",
                            Fact(name, f"taught naming for {rule.folder}", Strength.TAUGHT),
                        )


DIGITS = re.compile(r"\d+")


def name_skeleton(file_name: str) -> str:
    return DIGITS.sub("#", file_name.lower())


def make_template(file_name: str, clean_name: str) -> str | None:
    """The clean name with the file name's numbers as slots, or None when it reuses none
    of them (then every similar file would get the same name)."""
    runs = DIGITS.findall(file_name)
    template, used = clean_name, False
    for i, run in enumerate(runs):
        pattern = re.compile(rf"(?<!\d){re.escape(run)}(?!\d)")
        if pattern.search(template):
            template = pattern.sub("{" + str(i) + "}", template, count=1)
            used = True
    return template if used else None


def fill_template(file_name: str, skeleton: str, template: str) -> str | None:
    if name_skeleton(file_name) != skeleton:
        return None
    runs = DIGITS.findall(file_name)
    try:
        return template.format(*runs)
    except (IndexError, KeyError, ValueError):
        return None


# Extension → instrument, for formats that only one kind of instrument writes.
EXTENSION_INSTRUMENTS = {
    ".eds": "QuantStudio",
    ".fcs": "Flow cytometer",
    ".ab1": "Sanger sequencer",
    ".czi": "Zeiss microscope",
    ".lif": "Leica microscope",
    ".nd2": "Nikon microscope",
    ".sc1": "Bio-Rad imager",
}

# Signatures in an instrument export's preamble or sheets → instrument.
HEADER_INSTRUMENTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bGen5\b"), "BioTek Gen5"),
    (re.compile(r"\bSpectraMax\b", re.I), "SpectraMax"),
    (re.compile(r"\bQuantStudio\b", re.I), "QuantStudio"),
    (re.compile(r"\bNanoDrop\b", re.I), "NanoDrop"),
    (re.compile(r"\bUNICORN\b|\bÄKTA\b|\bAKTA\b"), "ÄKTA"),
    (re.compile(r"\bCLARIOstar\b|\bPHERAstar\b", re.I), "BMG plate reader"),
]

# Camera makers of gel and blot imagers; a phone or a DSLR is not an instrument.
IMAGER_MAKES = ("bio-rad", "azure", "li-cor", "amersham", "syngene", "uvp", "ge healthcare")


def extension_instrument(f: FileInfo, _ctx: LabContext) -> Iterable[Finding]:
    ext = PurePosixPath(f.path).suffix.lower()
    if ext in EXTENSION_INSTRUMENTS:
        yield "instrument", Fact(EXTENSION_INSTRUMENTS[ext], f"{ext} file", Strength.STRONG)


def header_instrument(f: FileInfo, _ctx: LabContext) -> Iterable[Finding]:
    # Only exports: a protocol that mentions "the QuantStudio" wasn't made by it.
    if f.file_kind != FileKind.SPREADSHEET:
        return
    for pattern, instrument in HEADER_INSTRUMENTS:
        if pattern.search(f.text[:4000]):
            yield "instrument", Fact(instrument, f"header mentions {instrument}", Strength.STRONG)
            return


def exif_instrument(f: FileInfo, _ctx: LabContext) -> Iterable[Finding]:
    exif = f.meta.get("exif", {})
    make, model = exif.get("Make", ""), exif.get("Model", "")
    if model and make.lower().startswith(IMAGER_MAKES):
        yield "instrument", Fact(model, f"EXIF camera {make} {model}", Strength.STRONG)


# (header words that must all appear, what the table is). First match wins.
SHEET_KINDS: list[tuple[tuple[str, ...], str]] = [
    (("compound", "dtm"), "thermal shift hits"),
    (("ligand", "tm"), "melting temperature summary"),
    (("rate", "conc"), "kinetics"),
    (("km",), "kinetics fit"),
    (("well", "fluorescence"), "DSF plate read"),
    (("well",), "plate read"),
]


def sheet_facts(f: FileInfo, _ctx: LabContext) -> Iterable[Finding]:
    if f.file_kind != FileKind.SPREADSHEET:
        return
    sheets = f.meta.get("sheets", [])
    headers = " ".join(" ".join(s.get("header", [])) for s in sheets)
    words = set(norm(headers).split())
    for needed, what in SHEET_KINDS:
        if all(w in words for w in needed):
            source = f"sheet columns {', '.join(sheets[0].get('header', [])[:4])}" if sheets else ""
            yield "what", Fact(what, source, Strength.STRONG)
            break
    if read := re.search(r"^Read \| (\S+)", f.text, re.M):
        yield "tag", Fact(read[1], "plate read type", Strength.STRONG)
    for s in sheets:
        name = s.get("name", "")
        if name and not re.fullmatch(r"(sheet\s*\d*|csv)", name, re.I):
            yield "tag", Fact(name.lower(), f"sheet {name!r}", Strength.MEDIUM)


# (pattern on the file name, what it is). Checked before the generic fallbacks by kind.
NAME_KINDS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"protocol", re.I), "protocol"),
    (re.compile(r"meeting", re.I), "meeting notes"),
    (re.compile(r"invoice", re.I), "invoice"),
    (re.compile(r"tray|crystal", re.I), "crystallization plan"),
    (re.compile(r"notes?\b", re.I), "notes"),
    (re.compile(r"buffer", re.I), "buffer recipes"),
    (re.compile(r"readme", re.I), "readme"),
]

KIND_FALLBACKS: dict[FileKind, str] = {
    FileKind.PDF: "document",
    FileKind.DOCUMENT: "document",
    FileKind.TEXT: "notes",
    FileKind.SPREADSHEET: "table",
}


def kind_what(f: FileInfo, _ctx: LabContext) -> Iterable[Finding]:
    stem = PurePosixPath(f.path).stem
    for pattern, what in NAME_KINDS:
        if pattern.search(stem):
            yield "what", Fact(what, f"file name {stem!r}", Strength.MEDIUM)
            return
    if f.file_kind == FileKind.IMAGE:
        exif = f.meta.get("exif", {})
        imager = exif.get("Make", "").lower().startswith(IMAGER_MAKES)
        yield "what", Fact("gel image" if imager else "photo", "image", Strength.WEAK)
    elif (ext := PurePosixPath(f.path).suffix.lower()) in EXTENSION_INSTRUMENTS:
        yield "what", Fact("run file", f"{ext} file", Strength.MEDIUM)
    elif f.file_kind in KIND_FALLBACKS and f.readable:
        yield "what", Fact(KIND_FALLBACKS[f.file_kind], f.file_kind.value, Strength.WEAK)


RULES: list[Rule] = [
    taught_rules,
    exif_date,
    name_date,
    folder_date,
    modified_date,
    folder_experiment,
    name_experiment,
    folder_person,
    name_person,
    extension_instrument,
    header_instrument,
    exif_instrument,
    sheet_facts,
    kind_what,
]

SERIAL = re.compile(r"(?i)\b(run|read|lane|rep|replicate)[ _-]?(\d+)")


@dataclass(frozen=True)
class Tier1:
    date: Fact[date] | None = None
    experiment: Fact[Experiment] | None = None
    person: Fact[Person] | None = None
    instrument: Fact[str] | None = None
    what: Fact[str] | None = None
    name: Fact[str] | None = None
    tags: tuple[str, ...] = ()
    conflicts: tuple[str, ...] = ()
    serial: str | None = None

    def clean_name(self) -> str | None:
        """A name built from the facts: what the file is, for which experiment or person."""
        if self.name:
            return self.name.value
        if self.what is None or (self.what.strength < Strength.MEDIUM and not self.experiment):
            return None
        subject = self.experiment.value.name if self.experiment else None
        if subject is None and self.person:
            subject = self.person.value.name
        if subject is None:
            return None
        name = f"{subject} {self.what.value}"
        if self.serial and self.serial.lower() not in name.lower():
            name = f"{name}, {self.serial}"
        return name[:1].upper() + name[1:]

    def confidence(self) -> float:
        name = self.clean_name()
        if name is None:
            return 0.0
        if self.name is not None:
            return 0.9
        score = 0.3 if self.what and self.what.strength >= Strength.MEDIUM else 0.2
        if self.experiment:
            score += 0.25 if self.experiment.strength >= Strength.STRONG else 0.1
        if self.date and self.date.strength >= Strength.STRONG:
            score += 0.1
        if self.person and self.person.strength >= Strength.STRONG:
            score += 0.1
        score -= 0.15 * len(self.conflicts)
        # Rules alone never skip a person's glance.
        return round(max(0.0, min(score, 0.8)), 2)

    def facts(self) -> list[str]:
        lines = []
        for label, fact in [
            ("date", self.date),
            ("experiment", self.experiment),
            ("person", self.person),
            ("instrument", self.instrument),
            ("what it is", self.what),
            ("taught name", self.name),
        ]:
            if fact is None:
                continue
            value = fact.value.name if isinstance(fact.value, Experiment | Person) else fact.value
            lines.append(f"- {label}: {value} (from {fact.source}; {fact.strength.name.lower()})")
        if self.tags:
            lines.append(f"- tags: {', '.join(self.tags)}")
        lines += [f"- conflict: {c}" for c in self.conflicts]
        return lines


def _key(value: object) -> object:
    return value.id if isinstance(value, Experiment | Person) else value


def _strongest(field: str, facts: list[Fact[Any]]) -> tuple[Fact[Any] | None, list[str]]:
    if not facts:
        return None, []
    top = max(f.strength for f in facts)
    best = [f for f in facts if f.strength == top]
    distinct = {_key(f.value): f for f in best}
    conflicts = []
    if len(distinct) > 1 and top > Strength.WEAK:
        shown = " vs ".join(
            f"{getattr(f.value, 'name', f.value)} ({f.source})" for f in distinct.values()
        )
        conflicts.append(f"{field}: {shown}")
    return best[0], conflicts


def tier1(f: FileInfo, ctx: LabContext) -> Tier1:
    found: dict[str, list[Fact[Any]]] = {}
    for rule in RULES:
        for field, fact in rule(f, ctx):
            found.setdefault(field, []).append(fact)
    picked: dict[str, Fact[Any] | None] = {}
    conflicts: list[str] = []
    for field in ("date", "experiment", "person", "instrument", "what", "name"):
        picked[field], more = _strongest(field, found.get(field, []))
        if field != "what":
            conflicts += more
    tags = tuple(dict.fromkeys(fact.value for fact in found.get("tag", [])))
    serial = SERIAL.search(PurePosixPath(f.path).stem)
    return Tier1(
        date=picked["date"],
        experiment=picked["experiment"],
        person=picked["person"],
        instrument=picked["instrument"],
        what=picked["what"],
        name=picked["name"],
        tags=tags,
        conflicts=tuple(conflicts),
        serial=f"{serial[1].lower()} {int(serial[2])}" if serial else None,
    )


def is_unknown_format(f: FileInfo) -> bool:
    return f.file_kind == FileKind.OTHER or not f.readable
