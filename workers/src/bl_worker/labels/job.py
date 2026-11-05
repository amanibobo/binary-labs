"""Labeling one blob in one lab: load what's known, ask the cheapest tier that can answer,
write the label. Every model answer is cached by (lab, sha256, purpose, model, prompt
version), so re-running converges without paying twice."""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from bl_worker import process
from bl_worker.domain import ExtractionKind, FileKind
from bl_worker.labels.decide import decide, tier3_reason
from bl_worker.labels.domain import (
    HUMAN_STATUSES,
    Draft,
    Example,
    Experiment,
    FileInfo,
    LabContext,
    LabelStatus,
    LabRule,
    Person,
    Proposal,
    RuleKind,
    Upload,
)
from bl_worker.labels.prompt import (
    CAPTION_INSTRUCTIONS,
    CAPTION_PROMPT_VERSION,
    LABEL_INSTRUCTIONS,
    LABEL_PROMPT_VERSION,
    CaptionOutput,
    InvalidOutput,
    LabelOutput,
    caption_content,
    file_text,
    lab_context_text,
    parse_caption,
    parse_label,
)
from bl_worker.labels.tier1 import Tier1, tier1
from bl_worker.model_cache import cached_call
from bl_worker.models import TIER2_MODEL, TIER3_MODEL, Image, ModelRequest
from bl_worker.previews import preview_key
from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

EXAMPLES = 8


def caption_extractor(model: str) -> str:
    return f"caption/{model}"


def load_file(conn: psycopg.Connection, lab_id: UUID, sha256: str) -> FileInfo | None:
    blob = conn.execute("select file_kind, mime from blobs where sha256 = %s", (sha256,)).fetchone()
    # A lab marked for deletion has no files to label, so no model is paid to label one.
    locations = conn.execute(
        "select fl.path, fl.modified_at from file_locations fl join labs l on l.id = fl.lab_id"
        " where fl.lab_id = %s and fl.sha256 = %s and fl.deleted_at is null"
        " and l.deletion_requested_at is null"
        " order by fl.modified_at desc, fl.path",
        (lab_id, sha256),
    ).fetchall()
    if blob is None or not locations:
        return None
    kind = FileKind(blob[0])
    extracted = process.stored_extraction(conn, sha256, kind)
    caption = conn.execute(
        "select content from extractions"
        " where sha256 = %s and extractor = %s and extractor_version = %s",
        (sha256, caption_extractor(TIER2_MODEL), CAPTION_PROMPT_VERSION),
    ).fetchone()
    upload = conn.execute(
        "select u.person_id, u.experiment_id, u.uploaded_on from uploads u"
        " join file_locations fl on fl.id = u.location_id"
        " where fl.lab_id = %s and fl.sha256 = %s and fl.deleted_at is null"
        " order by u.uploaded_at limit 1",
        (lab_id, sha256),
    ).fetchone()
    instrument = conn.execute(
        "select i.name from instruments i join file_locations fl on fl.source_id = i.source_id"
        " where fl.lab_id = %s and fl.sha256 = %s and fl.deleted_at is null"
        " order by fl.modified_at desc, fl.id limit 1",
        (lab_id, sha256),
    ).fetchone()
    return FileInfo(
        lab_id=lab_id,
        sha256=sha256,
        file_kind=kind,
        mime=blob[1],
        paths=tuple(p for p, _ in locations),
        modified_at=locations[0][1],
        text=extracted.content if extracted else "",
        meta=extracted.meta if extracted else {},
        caption=caption[0] if caption else None,
        readable=extracted is not None,
        upload=Upload(*upload) if upload else None,
        instrument=instrument[0] if instrument else None,
    )


def load_context(conn: psycopg.Connection, lab_id: UUID) -> LabContext:
    experiments = tuple(
        Experiment(id, name, tuple(aliases))
        for id, name, aliases in conn.execute(
            "select id, name, aliases from experiments where lab_id = %s order by name", (lab_id,)
        )
    )
    people = tuple(
        Person(id, name, tuple(aliases))
        for id, name, aliases in conn.execute(
            "select id, display_name, aliases from people where lab_id = %s order by display_name",
            (lab_id,),
        )
    )
    rules = tuple(
        LabRule(RuleKind(kind), folder, skeleton, template, exp, person)
        for kind, folder, skeleton, template, exp, person in conn.execute(
            "select kind, folder, name_skeleton, template, experiment_id, person_id"
            " from label_rules where lab_id = %s order by created_at",
            (lab_id,),
        )
    )
    ctx = LabContext(experiments, people, rules)
    rows = conn.execute(
        """
        select c.before, c.after,
          (select fl.path from file_locations fl
           where fl.lab_id = c.lab_id and fl.sha256 = c.sha256 order by fl.modified_at desc limit 1)
        from corrections c
        where c.lab_id = %s and c.undoes is null
          and not exists (select 1 from corrections u where u.undoes = c.id)
          and c.after ->> 'status' = 'corrected'
        order by c.id desc limit %s
        """,
        (lab_id, EXAMPLES),
    ).fetchall()
    examples = tuple(
        Example(path or "", _shown(ctx, before), _shown(ctx, after))
        for before, after, path in reversed(rows)
    )
    return LabContext(experiments, people, rules, examples)


def _shown(ctx: LabContext, state: dict[str, Any]) -> dict[str, Any]:
    exp = ctx.experiment(UUID(state["experiment_id"])) if state.get("experiment_id") else None
    person = ctx.person(UUID(state["person_id"])) if state.get("person_id") else None
    return {
        "clean_name": state.get("clean_name"),
        "date": state.get("date"),
        "experiment": exp.name if exp else None,
        "person": person.name if person else None,
        "instrument": state.get("instrument"),
        "tags": state.get("tags", []),
    }


def ensure_caption(conn: psycopg.Connection, rt: Runtime, f: FileInfo) -> FileInfo:
    """Images get a Tier 2 description once per blob, stored as an extraction and chunked
    so search finds the image by what it shows."""
    if f.file_kind != FileKind.IMAGE or f.caption is not None or rt.models is None:
        return f
    thumbnail = rt.previews.get(preview_key(f.lab_id, f.sha256))
    if thumbnail is None:
        return f
    request = ModelRequest(
        model=TIER2_MODEL,
        system=(CAPTION_INSTRUCTIONS,),
        content=(Image(thumbnail, "image/webp"), f"File: {f.path}"),
        schema=CaptionOutput,
    )
    text = cached_call(
        conn, rt.models, f.lab_id, f.sha256, "caption", request, CAPTION_PROMPT_VERSION
    )
    if text is None:
        return f
    try:
        content = caption_content(parse_caption(text))
    except InvalidOutput as e:
        log.warning("caption for %s unusable: %s", f.sha256[:12], e)
        return f
    conn.execute(
        "insert into extractions (sha256, extractor, extractor_version, kind, content)"
        " values (%s, %s, %s, %s, %s) on conflict do nothing",
        (
            f.sha256,
            caption_extractor(TIER2_MODEL),
            CAPTION_PROMPT_VERSION,
            ExtractionKind.IMAGE_CAPTION,
            content,
        ),
    )
    process.rechunk(conn, rt.embedder, f.lab_id, f.sha256, f.file_kind)
    return FileInfo(**{**f.__dict__, "caption": content})


def _ask(
    conn: psycopg.Connection,
    rt: Runtime,
    f: FileInfo,
    ctx: LabContext,
    t1: Tier1,
    model: str,
    earlier: Proposal | None,
    call_models: bool,
) -> Proposal | None:
    request = ModelRequest(
        model=model,
        system=(LABEL_INSTRUCTIONS, lab_context_text(ctx)),
        content=(file_text(f, t1, earlier),),
        schema=LabelOutput,
        effort="low" if model == TIER2_MODEL else "medium",
        max_tokens=4000 if model == TIER2_MODEL else 8000,
    )
    text = cached_call(
        conn,
        rt.models,
        f.lab_id,
        f.sha256,
        "label",
        request,
        LABEL_PROMPT_VERSION,
        call_models=call_models,
    )
    if text is None:
        return None
    try:
        return parse_label(text, ctx, model)
    except InvalidOutput as e:
        log.warning("%s label for %s unusable: %s", model, f.sha256[:12], e)
        return None


def label_blob(rt: Runtime, lab_id: UUID, sha256: str, *, call_models: bool = True) -> Draft | None:
    """Labels one blob for one lab. Never touches a label a person accepted or corrected.
    With call_models=False only cached model answers are used (re-suggesting)."""
    with rt.pool.connection() as conn:
        f = load_file(conn, lab_id, sha256)
        if f is None:
            return None
        current = conn.execute(
            "select status from labels where lab_id = %s and sha256 = %s", (lab_id, sha256)
        ).fetchone()
        if current is not None and LabelStatus(current[0]) in HUMAN_STATUSES:
            return None
        ctx = load_context(conn, lab_id)
        if call_models:
            f = ensure_caption(conn, rt, f)
        t1 = tier1(f, ctx)
        proposal = _ask(conn, rt, f, ctx, t1, TIER2_MODEL, None, call_models)
        if rt.models is not None or not call_models:
            why = tier3_reason(f, t1, proposal)
            if why is not None:
                log.info("tier 3 for %s: %s", sha256[:12], why)
                proposal = (
                    _ask(conn, rt, f, ctx, t1, TIER3_MODEL, proposal, call_models) or proposal
                )
        draft = decide(t1, proposal)
        write_label(conn, lab_id, sha256, draft)
        return draft


UPSERT_LABEL = """
insert into labels as l (lab_id, sha256, status, clean_name, date, experiment_id, person_id,
  instrument, tags, confidence, source, reason, updated_at)
values (%(lab_id)s, %(sha256)s, %(status)s, %(clean_name)s, %(date)s, %(experiment_id)s,
  %(person_id)s, %(instrument)s, %(tags)s, %(confidence)s, %(source)s, %(reason)s, now())
on conflict (lab_id, sha256) do update set
  status = excluded.status, clean_name = excluded.clean_name, date = excluded.date,
  experiment_id = excluded.experiment_id, person_id = excluded.person_id,
  instrument = excluded.instrument, tags = excluded.tags, confidence = excluded.confidence,
  source = excluded.source, reason = excluded.reason, updated_at = now()
where l.status not in ('accepted', 'corrected')
  and (l.status, l.clean_name, l.date, l.experiment_id, l.person_id, l.instrument, l.tags,
    l.confidence, l.source)
    is distinct from (excluded.status, excluded.clean_name, excluded.date,
    excluded.experiment_id, excluded.person_id, excluded.instrument, excluded.tags,
    excluded.confidence, excluded.source)
"""


def write_label(conn: psycopg.Connection, lab_id: UUID, sha256: str, d: Draft) -> None:
    conn.execute(
        UPSERT_LABEL,
        {
            "lab_id": lab_id,
            "sha256": sha256,
            "status": d.status,
            "clean_name": d.clean_name,
            "date": d.date,
            "experiment_id": d.experiment_id,
            "person_id": d.person_id,
            "instrument": d.instrument,
            "tags": list(d.tags),
            "confidence": d.confidence,
            "source": d.source,
            "reason": d.reason,
        },
    )


# Blobs that still need a label: none yet, or a rules-only label made while no model was
# configured. A blob whose model call already ran (even a refusal) is done.
UNLABELED = """
select distinct fl.lab_id, fl.sha256 from file_locations fl
join labs lab on lab.id = fl.lab_id and lab.deletion_requested_at is null
left join labels l on l.lab_id = fl.lab_id and l.sha256 = fl.sha256
where fl.sha256 is not null and fl.deleted_at is null and fl.index_state <> 'pending'
  and (l.sha256 is null or (%(models)s and l.source = 'rules'
    and l.status not in ('accepted', 'corrected')
    and not exists (select 1 from model_calls m where m.lab_id = fl.lab_id
      and m.sha256 = fl.sha256 and m.purpose = 'label')))
limit %(limit)s
"""


def unlabeled(
    conn: psycopg.Connection, *, models: bool, limit: int = 200
) -> list[tuple[UUID, str]]:
    with conn.cursor(row_factory=dict_row) as cur:
        rows = cur.execute(UNLABELED, {"models": models, "limit": limit}).fetchall()
    return [(r["lab_id"], r["sha256"]) for r in rows]
