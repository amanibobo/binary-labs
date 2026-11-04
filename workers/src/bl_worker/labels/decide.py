"""From Tier 1 facts and a model's proposal to the label the worker writes. Pure."""

from __future__ import annotations

from bl_worker.labels.domain import Draft, FileInfo, LabelStatus, Proposal, Strength
from bl_worker.labels.tier1 import Tier1, is_unknown_format

SUGGESTED_AT = 0.85
CHECK_AT = 0.5


def status_for(confidence: float) -> LabelStatus:
    """PRD: 0.85 or higher is suggested, 0.5 up to 0.85 is check, under 0.5 needs a look."""
    if confidence >= SUGGESTED_AT:
        return LabelStatus.SUGGESTED
    if confidence >= CHECK_AT:
        return LabelStatus.CHECK
    return LabelStatus.NEEDS_LOOK


def tier3_reason(f: FileInfo, t1: Tier1, t2: Proposal | None) -> str | None:
    """Why a file goes on to the large model, or None when Tier 2's answer stands."""
    if is_unknown_format(f):
        return "unknown format"
    if t2 is None:
        return "no usable answer from tier 2"
    if t2.confidence < SUGGESTED_AT:
        return f"tier 2 confidence {t2.confidence:.2f}"
    if t1.conflicts:
        return "conflicting rule facts"
    disagreements = [
        name
        for name, fact, value in [
            ("experiment", t1.experiment, t2.experiment),
            ("person", t1.person, t2.person),
            ("date", t1.date, t2.date),
        ]
        if fact is not None
        and fact.strength >= Strength.STRONG
        and value is not None
        and value != fact.value
    ]
    if disagreements:
        return "tier 2 disagrees with rules on " + ", ".join(disagreements)
    return None


def decide(t1: Tier1, proposal: Proposal | None) -> Draft:
    if proposal is None:
        name, confidence = t1.clean_name(), t1.confidence()
        experiment = t1.experiment.value if t1.experiment else None
        person = t1.person.value if t1.person else None
        day = t1.date.value if t1.date else None
        instrument = t1.instrument.value if t1.instrument else None
        tags, source, reason = t1.tags, "rules", "Tier 1 rules only"
    else:
        name, confidence = proposal.clean_name, proposal.confidence
        experiment = proposal.experiment or (t1.experiment.value if t1.experiment else None)
        person = proposal.person or (t1.person.value if t1.person else None)
        day = proposal.date or (t1.date.value if t1.date else None)
        # Rule instruments are canonical strings, so the same instrument reads the same.
        strong_instrument = t1.instrument and t1.instrument.strength >= Strength.STRONG
        instrument = t1.instrument.value if strong_instrument else proposal.instrument
        tags, source, reason = proposal.tags, proposal.model, proposal.reason
        if name is None:
            confidence = 0.0

    taught = False
    if t1.experiment and t1.experiment.strength == Strength.TAUGHT:
        experiment, taught = t1.experiment.value, True
    if t1.person and t1.person.strength == Strength.TAUGHT:
        person, taught = t1.person.value, True
    if t1.name and t1.name.strength == Strength.TAUGHT:
        name, taught = t1.name.value, True
        confidence = max(confidence, SUGGESTED_AT)

    status = status_for(confidence)
    # A person settled the uncertain part, so a "check" becomes a suggestion; a guess
    # (needs a look) stays a guess.
    if taught and status == LabelStatus.CHECK:
        status = LabelStatus.SUGGESTED
    if name is None or status == LabelStatus.NEEDS_LOOK:
        return Draft(
            LabelStatus.NEEDS_LOOK, None, None, None, None, None, (), confidence, source, reason
        )
    return Draft(
        status=status,
        clean_name=name,
        date=day,
        experiment_id=experiment.id if experiment else None,
        person_id=person.id if person else None,
        instrument=instrument,
        tags=tuple(tags),
        confidence=confidence,
        source=source,
        reason=reason,
    )
