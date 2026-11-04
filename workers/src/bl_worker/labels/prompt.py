"""What Tier 2 and Tier 3 see, and the strict parse of what they answer."""

from __future__ import annotations

import json
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError

from bl_worker.labels.domain import FileInfo, LabContext, Proposal
from bl_worker.labels.tier1 import Tier1

LABEL_PROMPT_VERSION = 1
CAPTION_PROMPT_VERSION = 1
EXCERPT_CHARS = 4000


class LabelOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clean_name: str | None
    date: str | None
    experiment: str | None
    person: str | None
    instrument: str | None
    tags: list[str]
    confidence: float
    reason: str


class CaptionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal[
        "gel", "blot", "plate", "notebook page", "chart", "microscopy", "screen", "photo", "other"
    ]
    description: str
    handwriting: str | None


class InvalidOutput(Exception):
    """The model's answer isn't the JSON we asked for; the file falls back to Tier 1."""


LABEL_INSTRUCTIONS = """\
You label files from a research lab's shared drive so people can find them later. You never \
rename or move the file; you suggest a label shown beside it.

Answer with JSON only:
- clean_name: a short, specific, human name for the file (3 to 10 words, sentence case, no \
file extension). Say what it is and what it belongs to, e.g. "P450 batch 3 SDS-PAGE gel" or \
"Lysozyme DSF run 2". Null if you can't tell what the file is.
- date: the day the work in the file happened, YYYY-MM-DD. Prefer dates in the content, \
EXIF, file name or folder over the file's modified time. Null if there is none.
- experiment: exactly one name from the lab's experiment list, or null. If the file clearly \
belongs to an experiment that isn't listed, leave it null and put that name in tags.
- person: exactly one name from the lab's people list, or null.
- instrument: the instrument that produced the file, or null for protocols, notes and \
documents. If the rule-based facts name an instrument, use that exact string.
- tags: up to 6 short lowercase tags (technique, sample, read type), no duplicates of the \
other fields.
- confidence: 0 to 1, how sure you are that a lab member would accept this label unchanged. \
Below 0.5 means you are guessing.
- reason: one sentence on what the label rests on.

Rule-based facts come from folders, names, EXIF and headers. They are usually right, but a \
file copied into the wrong folder can contradict its content; say so in reason and lower \
confidence when signals conflict."""


def lab_context_text(ctx: LabContext) -> str:
    lines = ["The lab's experiments (name: aliases):"]
    lines += [f"- {e.name}: {', '.join(e.aliases) or '-'}" for e in ctx.experiments] or ["- none"]
    lines.append("The lab's people (name: initials and aliases):")
    lines += [f"- {p.name}: {', '.join(p.aliases) or '-'}" for p in ctx.people] or ["- none"]
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
    lines.append("Rule-based facts:")
    lines += t1.facts() or ["- none"]
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


def proposal_json(p: Proposal) -> dict[str, object]:
    return {
        "clean_name": p.clean_name,
        "date": p.date.isoformat() if p.date else None,
        "experiment": p.experiment.name if p.experiment else None,
        "person": p.person.name if p.person else None,
        "instrument": p.instrument,
        "tags": list(p.tags),
        "confidence": p.confidence,
        "reason": p.reason,
    }


def parse_label(text: str, ctx: LabContext, model: str) -> Proposal:
    """The boundary: strict JSON in, a Proposal with lab-resolved names out."""
    try:
        out = LabelOutput.model_validate_json(text)
    except ValidationError as e:
        raise InvalidOutput(str(e).splitlines()[0]) from e
    if not 0 <= out.confidence <= 1:
        raise InvalidOutput(f"confidence {out.confidence} is outside 0..1")
    try:
        day = date.fromisoformat(out.date) if out.date else None
    except ValueError as e:
        raise InvalidOutput(f"date {out.date!r} is not YYYY-MM-DD") from e
    name = (out.clean_name or "").strip()[:200] or None
    tags = [t.strip().lower()[:60] for t in out.tags if t.strip()]
    experiment = ctx.find_experiment(out.experiment)
    if out.experiment and experiment is None:
        tags.append(out.experiment.strip().lower()[:60])
    person = ctx.find_person(out.person)
    instrument = (out.instrument or "").strip()[:120] or None
    return Proposal(
        clean_name=name,
        date=day,
        experiment=experiment,
        person=person,
        instrument=instrument,
        tags=tuple(dict.fromkeys(tags))[:20],
        confidence=out.confidence,
        reason=out.reason.strip()[:500],
        model=model,
    )


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


CAPTION_INSTRUCTIONS = """\
You describe images from a research lab's shared drive so they can be found by search. \
Answer with JSON only:
- kind: what the image is.
- description: two or three sentences a scientist would search for: for a gel or blot, \
the number of lanes, a ladder if present, and where the strong bands are; for a plate, its \
format and any pattern; for a notebook page, its topic. Mention any printed labels.
- handwriting: a transcription of any handwriting, or null."""
