"""Labeling one blob in one lab: load what's known, ask the cheapest tier that can answer,
write the label. Every model answer is cached by (lab, sha256, purpose, model, prompt
version), so re-running converges without paying twice."""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from bl_worker import process
from bl_worker.domain import ExtractionKind, FileKind
from bl_worker.labels.decide import decide, tier3_reason
from bl_worker.labels.domain import (
    HUMAN_STATUSES,
    Choice,
    Condition,
    ConditionKind,
    Draft,
    Example,
    Experiment,
    FileInfo,
    FollowUp,
    LabContext,
    LabelStatus,
    LabRule,
    Person,
    Proposal,
    RuleKind,
    Upload,
    folder_of,
)
from bl_worker.labels.prompt import (
    CAPTION_INSTRUCTIONS,
    CAPTION_PROMPT_VERSION,
    LAB_TAGS,
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
    source_text,
)
from bl_worker.labels.tier1 import Tier1, tier1
from bl_worker.labels.titles import differing_detail, with_detail
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
    tags = tuple(
        t
        for (t,) in conn.execute(
            "select t from labels l, unnest(l.tags) t where l.lab_id = %s"
            " and l.status <> 'needs_look' group by t order by count(*) desc, t limit %s",
            (lab_id, LAB_TAGS),
        )
    )
    return LabContext(experiments, people, rules, examples, tags)


NEIGHBORS = 5


def recent_titles(
    conn: psycopg.Connection, f: FileInfo, experiment_id: UUID | None
) -> tuple[str, ...]:
    """A few recent titles from the same experiment, else from the same folder, so a new
    label is worded like its neighbors."""
    folder = folder_of(f.path)
    rows = conn.execute(
        """
        select l.clean_name from labels l
        where l.lab_id = %(lab)s and l.sha256 <> %(sha)s and l.clean_name is not null
          and l.status <> 'needs_look'
          and (case when %(exp)s::uuid is not null then l.experiment_id = %(exp)s
            else exists (select 1 from file_locations fl where fl.lab_id = l.lab_id
              and fl.sha256 = l.sha256 and fl.deleted_at is null
              and lower(fl.path) like %(folder)s || '/%%') end)
        order by l.updated_at desc limit %(n)s
        """,
        {
            "lab": f.lab_id,
            "sha": f.sha256,
            "exp": experiment_id,
            "folder": folder.rstrip("/"),
            "n": NEIGHBORS,
        },
    ).fetchall()
    return tuple(dict.fromkeys(r[0] for r in rows))


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
        "outcome": state.get("outcome"),
        "summary": state.get("summary"),
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
        content=(file_text(f, t1, earlier, ctx.tags),),
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
        return parse_label(text, ctx, model, source=source_text(f), kind=f.file_kind)
    except InvalidOutput as e:
        log.warning("%s label for %s unusable: %s", model, f.sha256[:12], e)
        return None


def propose(
    conn: psycopg.Connection,
    rt: Runtime,
    f: FileInfo,
    ctx: LabContext,
    t1: Tier1,
    *,
    call_models: bool,
) -> tuple[Proposal | None, bool]:
    """Tier 2, then Tier 3 when Tier 2 isn't sure. Also says whether a model answered
    (fresh or cached) at the current prompt version."""
    proposal = _ask(conn, rt, f, ctx, t1, TIER2_MODEL, None, call_models)
    if rt.models is not None or not call_models:
        why = tier3_reason(f, t1, proposal)
        if why is not None:
            log.info("tier 3 for %s: %s", f.sha256[:12], why)
            proposal = _ask(conn, rt, f, ctx, t1, TIER3_MODEL, proposal, call_models) or proposal
    asked = conn.execute(
        "select 1 from model_calls where lab_id = %s and sha256 = %s and purpose = 'label'"
        " and prompt_version = %s limit 1",
        (f.lab_id, f.sha256, LABEL_PROMPT_VERSION),
    ).fetchone()
    return proposal, asked is not None


def note_cover(conn: psycopg.Connection, lab_id: UUID, sha256: str) -> UUID | None:
    """The note whose first page this file is, if any: that page carries the note's label."""
    row = conn.execute(
        "select np.note_id from note_pages np where np.lab_id = %s and np.sha256 = %s"
        " and np.live and np.position = (select min(p.position) from note_pages p"
        " where p.note_id = np.note_id and p.live)",
        (lab_id, sha256),
    ).fetchone()
    return row[0] if row else None


def label_blob(rt: Runtime, lab_id: UUID, sha256: str, *, call_models: bool = True) -> Draft | None:
    """Labels one blob for one lab. Never touches a value a person accepted or corrected; a
    label from before the current prompt gets only the fields it didn't have. The first page of
    a note is labeled as the whole note. With call_models=False only cached model answers are
    used (re-suggesting)."""
    with rt.pool.connection() as conn:
        note = note_cover(conn, lab_id, sha256)
        # The first page gets its own label (and description) first; the note waits for it.
        unlabeled = (
            conn.execute(
                "select 1 from labels where lab_id = %s and sha256 = %s", (lab_id, sha256)
            ).fetchone()
            is None
        )
    if note is not None and not unlabeled:
        from bl_worker.labels.notes import label_note

        return label_note(rt, note, call_models=call_models)
    with rt.pool.connection() as conn:
        f = load_file(conn, lab_id, sha256)
        if f is None:
            return None
        current = conn.execute(
            "select status, prompt_version from labels where lab_id = %s and sha256 = %s",
            (lab_id, sha256),
        ).fetchone()
        human = current is not None and LabelStatus(current[0]) in HUMAN_STATUSES
        if human and (current[1] or 0) >= LABEL_PROMPT_VERSION:
            return None
        ctx = load_context(conn, lab_id)
        if call_models:
            f = ensure_caption(conn, rt, f)
        t1 = tier1(f, ctx)
        experiment = t1.experiment.value.id if t1.experiment else None
        if experiment is None and f.upload is not None:
            experiment = f.upload.experiment_id
        f = replace(f, neighbors=recent_titles(conn, f, experiment))
        proposal, asked = propose(conn, rt, f, ctx, t1, call_models=call_models)
        draft = decide(t1, proposal, file=f, prompt_version=LABEL_PROMPT_VERSION if asked else None)
        if human:
            if asked:
                fill_new_fields(conn, lab_id, sha256, draft)
            return None
        draft = with_follow_up_choices(conn, f, ctx, draft)
        draft = distinct_title(conn, f, draft)
        write_label(conn, lab_id, sha256, draft)
        return draft


def with_follow_up_choices(
    conn: psycopg.Connection, f: FileInfo, ctx: LabContext, d: Draft
) -> Draft:
    """A voice note's question offers at least two choices: the model's, then the lab's
    recent experiments or the recent days with files. No question once the field is known."""
    q = d.follow_up
    if q is None:
        return d
    if (q.field == "experiment" and d.experiment_id is not None) or (
        q.field == "date" and d.date is not None
    ):
        return replace(d, follow_up=None)
    choices = list(q.choices)
    if len(choices) < 2 and q.field == "experiment":
        for (exp_id,) in conn.execute(
            "select l.experiment_id from labels l where l.lab_id = %s and l.experiment_id"
            " is not null group by 1 order by max(l.updated_at) desc limit 4",
            (f.lab_id,),
        ):
            exp = ctx.experiment(exp_id)
            if exp is not None:
                choices.append(Choice(exp.name, str(exp.id)))
    elif len(choices) < 2:
        for (day,) in conn.execute(
            "select distinct l.date from labels l where l.lab_id = %s and l.date"
            " between %s::date - 14 and %s::date order by l.date desc limit 4",
            (f.lab_id, f.modified_at.date(), f.modified_at.date()),
        ):
            choices.append(Choice(day.strftime("%a, %b %-d"), day.isoformat()))
    unique = tuple({c.value: c for c in choices}.values())[:4]
    if not unique:
        return replace(d, follow_up=None)
    return replace(d, follow_up=FollowUp(q.field, q.question, unique))


def distinct_title(conn: psycopg.Connection, f: FileInfo, d: Draft) -> Draft:
    """When another file in the lab already has this title, both get the one detail that
    tells them apart; a title a person gave stays as it is."""
    if d.clean_name is None:
        return d
    rows = conn.execute(
        """
        select l.sha256, l.status, l.conditions,
          (select fl.path from file_locations fl where fl.lab_id = l.lab_id
            and fl.sha256 = l.sha256 and fl.deleted_at is null order by fl.modified_at desc limit 1)
        from labels l
        where l.lab_id = %s and l.sha256 <> %s and lower(l.clean_name) = lower(%s)
          and exists (select 1 from file_locations fl where fl.lab_id = l.lab_id
            and fl.sha256 = l.sha256 and fl.deleted_at is null)
        """,
        (f.lab_id, f.sha256, d.clean_name),
    ).fetchall()
    name = d.clean_name
    for other_sha, status, other_conditions, other_path in rows:
        if other_path is None:
            continue
        theirs = tuple(
            Condition(ConditionKind(c["kind"]), c["what"], c["value"], c["unit"])
            for c in other_conditions
        )
        details = differing_detail(f.path, other_path, d.conditions, theirs)
        if details is None:
            continue
        mine, other = details
        if mine:
            name = with_detail(name, mine)
        if other and LabelStatus(status) not in HUMAN_STATUSES:
            conn.execute(
                "update labels set clean_name = %s, updated_at = now()"
                " where lab_id = %s and sha256 = %s and status not in ('accepted', 'corrected')",
                (with_detail(d.clean_name, other), f.lab_id, other_sha),
            )
        break
    return replace(d, clean_name=name)


FILL_NEW_FIELDS = """
update labels set note_kind = %(note_kind)s, outcome = %(outcome)s, summary = %(summary)s,
  conditions = %(conditions)s, prompt_version = %(prompt_version)s, updated_at = now()
where lab_id = %(lab_id)s and sha256 = %(sha256)s and status in ('accepted', 'corrected')
  and coalesce(prompt_version, 0) < %(prompt_version)s
"""


def fill_new_fields(conn: psycopg.Connection, lab_id: UUID, sha256: str, d: Draft) -> None:
    """A label a person confirmed before outcomes and summaries existed gets them, and nothing
    else of it changes."""
    conn.execute(
        FILL_NEW_FIELDS,
        {
            "lab_id": lab_id,
            "sha256": sha256,
            "note_kind": d.note_kind,
            "outcome": d.outcome,
            "summary": d.summary,
            "conditions": Jsonb([c.json() for c in d.conditions]),
            "prompt_version": d.prompt_version,
        },
    )


LABEL_COLUMNS = (
    "status, clean_name, date, experiment_id, person_id, instrument, tags, confidence, source,"
    " reason, note_kind, outcome, summary, conditions, alternatives, unclear, follow_up,"
    " prompt_version"
)

UPSERT_LABEL = f"""
insert into labels as l (lab_id, sha256, {LABEL_COLUMNS}, updated_at)
values (%(lab_id)s, %(sha256)s, %(status)s, %(clean_name)s, %(date)s, %(experiment_id)s,
  %(person_id)s, %(instrument)s, %(tags)s, %(confidence)s, %(source)s, %(reason)s,
  %(note_kind)s, %(outcome)s, %(summary)s, %(conditions)s, %(alternatives)s, %(unclear)s,
  %(follow_up)s, %(prompt_version)s, now())
on conflict (lab_id, sha256) do update set
  status = excluded.status, clean_name = excluded.clean_name, date = excluded.date,
  experiment_id = excluded.experiment_id, person_id = excluded.person_id,
  instrument = excluded.instrument, tags = excluded.tags, confidence = excluded.confidence,
  source = excluded.source, reason = excluded.reason, note_kind = excluded.note_kind,
  outcome = excluded.outcome, summary = excluded.summary, conditions = excluded.conditions,
  alternatives = excluded.alternatives, unclear = excluded.unclear,
  follow_up = excluded.follow_up, prompt_version = excluded.prompt_version, updated_at = now()
where l.status not in ('accepted', 'corrected')
  and ({", ".join("l." + c.strip() for c in LABEL_COLUMNS.split(","))})
    is distinct from ({", ".join("excluded." + c.strip() for c in LABEL_COLUMNS.split(","))})
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
            "note_kind": d.note_kind,
            "outcome": d.outcome,
            "summary": d.summary,
            "conditions": Jsonb([c.json() for c in d.conditions]),
            "alternatives": list(d.alternatives),
            "unclear": list(d.unclear),
            "follow_up": Jsonb(d.follow_up.json()) if d.follow_up else None,
            "prompt_version": d.prompt_version,
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
