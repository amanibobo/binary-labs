"""What Tier 2 and Tier 3 see, and the strict parse of what they answer."""

from __future__ import annotations

import json
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError

from bl_worker.domain import FileKind
from bl_worker.labels.domain import (
    UNCLEAR,
    Choice,
    Condition,
    ConditionKind,
    FileInfo,
    FollowUp,
    LabContext,
    NoteKind,
    Outcome,
    Proposal,
)
from bl_worker.labels.grounding import (
    UNCLEAR_CAP,
    ground_conditions,
    ground_text,
    merge_unclear,
    numbers_in,
)
from bl_worker.labels.tier1 import Tier1
from bl_worker.labels.titles import MAX_TITLE, same_title, tidy_title

# 2: outcome, summary, conditions, note kind, other titles, what was unclear, the voice note's
# question, short titles and the lab's own words.
LABEL_PROMPT_VERSION = 2
# 2: anything not clearly legible is [unclear].
CAPTION_PROMPT_VERSION = 2
EXCERPT_CHARS = 4000
SUMMARY_MAX = 300
MAX_CONDITIONS = 16
LAB_TAGS = 40


class ConditionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["condition", "sample", "material", "attendee", "decision"]
    what: str
    value: str | None
    unit: str | None


class FollowUpOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: Literal["experiment", "date"]
    question: str
    choices: list[str]


class LabelOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clean_name: str | None
    alternatives: list[str]
    date: str | None
    experiment: str | None
    person: str | None
    instrument: str | None
    tags: list[str]
    note_kind: Literal[
        "experiment_notes",
        "meeting_notes",
        "reading_summary",
        "lecture",
        "protocol",
        "data",
        "image",
        "other",
    ]
    outcome: Literal["worked", "failed", "repeat", "final", "unclear"] | None
    summary: str | None
    conditions: list[ConditionOutput]
    unclear: list[str]
    follow_up: FollowUpOutput | None
    confidence: float
    reason: str


class PageRoleOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page: int
    role: Literal["setup", "readings", "reflection", "other"]


class NoteOutput(LabelOutput):
    """A label read across every page of a note, and what each page is for."""

    pages: list[PageRoleOutput]


class CaptionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal[
        "gel", "blot", "plate", "notebook page", "chart", "microscopy", "screen", "photo", "other"
    ]
    description: str
    handwriting: str | None


class InvalidOutput(Exception):
    """The model's answer isn't the JSON we asked for; the file falls back to Tier 1."""


LABEL_INSTRUCTIONS = f"""\
You label files from a research lab's shared drive so people can find them later, often months \
from now. You never rename or move the file; you suggest a label shown beside it.

Never invent anything. Every value, number and name must be in the file, its image \
description, its path or the rule-based facts. Anything not clearly legible or not stated is \
written as {UNCLEAR}, never guessed, and named in unclear.

Answer with JSON only:
- clean_name: a short title, at most {MAX_TITLE} characters, sentence case, no file extension. \
The subject plus the one detail that tells it apart from similar files, in the lab's own words \
(reuse its experiment names, tags and recent titles), e.g. "P450 batch 3 SDS-PAGE gel" or \
"HeLa drug A dose series, plate 3". No date (the date is its own field), no filler like \
"Notes on" or "Results of", no pipes. Null if you can't tell what the file is.
- alternatives: when confidence is under 0.85, two other short titles a lab member might \
prefer (different wording or a different distinguishing detail); otherwise empty.
- date: the day the work in the file happened, YYYY-MM-DD. Prefer dates in the content, \
EXIF, file name or folder over the file's modified time. Null if there is none.
- experiment: exactly one name from the lab's experiment list, or null. If the file clearly \
belongs to an experiment that isn't listed, leave it null and put that name in tags.
- person: exactly one name from the lab's people list, or null.
- instrument: the instrument that produced the file, or null for protocols, notes and \
documents. If the rule-based facts name an instrument, use that exact string.
- tags: up to 6 short lowercase tags (technique, sample, read type), no duplicates of the \
other fields. Prefer tags the lab already uses.
- note_kind: experiment_notes, meeting_notes, reading_summary, lecture, protocol, data \
(an instrument export or data sheet), image (a gel, blot, plate or other picture of results), \
or other.
- outcome: for a run or experiment only, and only when the file says so: worked, failed \
("outer wells drifted, results unreliable" is failed), repeat (a re-run of an earlier one), \
final (the version to use), or unclear (the file discusses the outcome but doesn't settle \
it). Null when the file doesn't say, and for things that aren't runs (protocols, papers, \
meeting notes).
- summary: one plain sentence a first-year student would understand, saying what the file \
is and what it found. Null if there's nothing to say beyond the title.
- conditions: the key facts, as the file states them, each with kind, what, value and unit \
(value and unit null when there is none). For runs and experiment notes: conditions (drug A \
0.1–100 µM, 37 °C, 30 min, plate 3, triplicate), samples and materials. For meeting notes: \
attendees and decisions, not concentrations. Keep values exactly as written; ranges as \
"0.1–100". At most {MAX_CONDITIONS}; empty when the file states none.
- unclear: each thing you couldn't read or the file leaves open that matters to the label, \
in a few words ("the concentration in well B3 on page 7"). Empty when everything is clear.
- follow_up: only for a voice note or talk-through transcript that leaves its experiment or \
date unclear ("that thing from Tuesday"): one short question, and as choices up to 4 \
experiment names from the lab's list or YYYY-MM-DD dates (resolve "Tuesday" against the \
recording's date). Null otherwise.
- confidence: 0 to 1, how sure you are that a lab member would accept this label unchanged. \
Below 0.5 means you are guessing. Anything in unclear means under 0.85.
- reason: one sentence on what the label rests on.

Rule-based facts come from folders, names, EXIF and headers. They are usually right, but a \
file copied into the wrong folder can contradict its content; say so in reason and lower \
confidence when signals conflict."""

NOTE_INSTRUCTIONS = (
    LABEL_INSTRUCTIONS
    + """

These pages belong together as one note (photographed or uploaded together). Label the note \
as a whole, reading across every page: one title, summary, outcome and conditions. Also \
answer pages: for every page number, its role: setup (aims, plate layout, what was prepared), \
readings (measurements, tables, results), reflection (what it means, what went wrong, next \
steps) or other."""
)


def lab_context_text(ctx: LabContext) -> str:
    lines = ["The lab's experiments (name: aliases):"]
    lines += [f"- {e.name}: {', '.join(e.aliases) or '-'}" for e in ctx.experiments] or ["- none"]
    lines.append("The lab's people (name: initials and aliases):")
    lines += [f"- {p.name}: {', '.join(p.aliases) or '-'}" for p in ctx.people] or ["- none"]
    if ctx.tags:
        lines.append("Tags the lab already uses: " + ", ".join(ctx.tags[:LAB_TAGS]))
    if ctx.examples:
        lines.append("Recent corrections by lab members; follow their naming habits:")
        for ex in ctx.examples:
            lines.append(
                f"- {ex.path}: suggested {json.dumps(ex.before, sort_keys=True)} "
                f"-> corrected {json.dumps(ex.after, sort_keys=True)}"
            )
    return "\n".join(lines)


def file_text(f: FileInfo, t1: Tier1, earlier: Proposal | None = None) -> str:
    lines = [f"File: {f.path}"]
    if len(f.paths) > 1:
        lines.append(f"Same content also at: {', '.join(f.paths[1:])}")
    lines.append(f"Kind: {f.file_kind.value} ({f.mime}), modified {f.modified_at.date()}")
    if f.file_kind in (FileKind.AUDIO, FileKind.VIDEO):
        lines.append(f"This is a voice recording; it was recorded on {f.modified_at.date()}.")
    lines.append("Rule-based facts:")
    lines += t1.facts() or ["- none"]
    if f.neighbors:
        lines.append("Recent titles of similar files in this lab: " + "; ".join(f.neighbors))
    if f.caption:
        lines.append(f"Image description: {f.caption}")
    if not f.readable:
        lines.append("The content could not be read (unknown or broken format).")
    elif f.text:
        lines.append(f"Extracted content (first {EXCERPT_CHARS} characters):")
        lines.append(f.text[:EXCERPT_CHARS])
    if earlier is not None:
        lines.append(
            "A faster model suggested this label; check it against everything above and "
            "correct anything that is wrong:\n" + json.dumps(proposal_json(earlier), sort_keys=True)
        )
    return "\n".join(lines)


def source_text(f: FileInfo) -> str:
    """Everything a label may take a number from."""
    return "\n".join([*f.paths, f.text, f.caption or ""])


def proposal_json(p: Proposal) -> dict[str, object]:
    return {
        "clean_name": p.clean_name,
        "alternatives": list(p.alternatives),
        "date": p.date.isoformat() if p.date else None,
        "experiment": p.experiment.name if p.experiment else None,
        "person": p.person.name if p.person else None,
        "instrument": p.instrument,
        "tags": list(p.tags),
        "note_kind": p.note_kind.value if p.note_kind else None,
        "outcome": p.outcome.value if p.outcome else None,
        "summary": p.summary,
        "conditions": [c.json() for c in p.conditions],
        "unclear": list(p.unclear),
        "confidence": p.confidence,
        "reason": p.reason,
    }


def _clip(text: str | None, limit: int) -> str | None:
    t = " ".join((text or "").split())[:limit].strip()
    return t or None


def _conditions(out: list[ConditionOutput]) -> list[Condition]:
    found: list[Condition] = []
    for c in out[:MAX_CONDITIONS]:
        what = _clip(c.what, 80)
        if what is None:
            continue
        found.append(Condition(ConditionKind(c.kind), what, _clip(c.value, 80), _clip(c.unit, 20)))
    return found


def _follow_up(out: FollowUpOutput | None, ctx: LabContext, kind: FileKind) -> FollowUp | None:
    # Only a voice note gets a question; a document that leaves its date open is just undated.
    if out is None or kind not in (FileKind.AUDIO, FileKind.VIDEO):
        return None
    question = _clip(out.question, 160)
    if question is None:
        return None
    choices: list[Choice] = []
    for text in out.choices:
        if out.field == "experiment":
            exp = ctx.find_experiment(text)
            if exp is not None:
                choices.append(Choice(exp.name, str(exp.id)))
        else:
            try:
                day = date.fromisoformat(text.strip())
            except ValueError:
                continue
            choices.append(Choice(day.strftime("%a, %b %-d"), day.isoformat()))
    unique = tuple({c.value: c for c in choices}.values())[:4]
    return FollowUp(out.field, question, unique)


def parse_label(
    text: str,
    ctx: LabContext,
    model: str,
    *,
    source: str = "",
    kind: FileKind = FileKind.OTHER,
    schema: type[LabelOutput] = LabelOutput,
) -> Proposal:
    """The boundary: strict JSON in, a Proposal with lab-resolved names, a short title and only
    numbers the file shows out."""
    try:
        out = schema.model_validate_json(text)
    except ValidationError as e:
        raise InvalidOutput(str(e).splitlines()[0]) from e
    if not 0 <= out.confidence <= 1:
        raise InvalidOutput(f"confidence {out.confidence} is outside 0..1")
    try:
        day = date.fromisoformat(out.date) if out.date else None
    except ValueError as e:
        raise InvalidOutput(f"date {out.date!r} is not YYYY-MM-DD") from e
    name = tidy_title(out.clean_name)
    alternatives = tuple(
        dict.fromkeys(
            a
            for a in (tidy_title(x) for x in out.alternatives)
            if a is not None and not same_title(a, name)
        )
    )[:2]
    tags = [t.strip().lower()[:60] for t in out.tags if t.strip()]
    experiment = ctx.find_experiment(out.experiment)
    if out.experiment and experiment is None:
        tags.append(out.experiment.strip().lower()[:60])
    person = ctx.find_person(out.person)
    instrument = (out.instrument or "").strip()[:120] or None

    conditions, hidden = ground_conditions(_conditions(out.conditions), source)
    summary = _clip(out.summary, SUMMARY_MAX)
    if summary is not None:
        summary, changed = ground_text(summary, numbers_in(source))
        if changed:
            hidden = (*hidden, "a number in the summary isn't clear in the file")
    unclear = merge_unclear(out.unclear, hidden, conditions)
    confidence = out.confidence
    if unclear:
        confidence = min(confidence, UNCLEAR_CAP)
    return Proposal(
        clean_name=name,
        date=day,
        experiment=experiment,
        person=person,
        instrument=instrument,
        tags=tuple(dict.fromkeys(tags))[:20],
        confidence=confidence,
        reason=out.reason.strip()[:500],
        model=model,
        note_kind=NoteKind(out.note_kind),
        outcome=Outcome(out.outcome) if out.outcome else None,
        summary=summary,
        conditions=conditions,
        # Other titles only help while the label asks for a look.
        alternatives=alternatives if confidence < 0.85 else (),
        unclear=unclear,
        follow_up=_follow_up(out.follow_up, ctx, kind),
    )


def page_roles(text: str, pages: int) -> dict[int, str]:
    """A note's page roles, page number to role, for the pages that exist."""
    try:
        out = NoteOutput.model_validate_json(text)
    except ValidationError:
        return {}
    return {p.page: p.role for p in out.pages if 1 <= p.page <= pages}


def parse_caption(text: str) -> CaptionOutput:
    try:
        return CaptionOutput.model_validate_json(text)
    except ValidationError as e:
        raise InvalidOutput(str(e).splitlines()[0]) from e


def caption_content(c: CaptionOutput) -> str:
    text = f"Image ({c.kind}): {c.description.strip()}"
    if c.handwriting and c.handwriting.strip():
        text += f"\nHandwriting: {c.handwriting.strip()}"
    return text


CAPTION_INSTRUCTIONS = f"""\
You describe images from a research lab's shared drive so they can be found by search. \
Answer with JSON only:
- kind: what the image is.
- description: two or three sentences a scientist would search for: for a gel or blot, \
the number of lanes, a ladder if present, and where the strong bands are; for a plate, its \
format and any pattern; for a notebook page, its topic. Mention any printed labels.
- handwriting: a transcription of any handwriting, line by line, or null. Write exactly what \
is written. Any word, number or unit you can't read with certainty (smudged, crossed out, cut \
off, too faint) is written as {UNCLEAR}; never guess a digit, and never fill in what a value \
"should" be."""
