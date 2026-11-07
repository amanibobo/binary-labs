"""Several pages as one note (decisions.md, "smart labels: outcomes, summaries, conditions and
notes"). Photos or screenshots uploaded together, or notebook pages photographed one after
another in one folder, are suggested as one note. The note's title, summary, outcome and
conditions are read across every page and kept as the label of its first page; each page
stays its own file with its own label, and gets a role (setup, readings, reflection, other).
Grouping is only ever suggested: people keep, split or join notes, and a split group is
never suggested again."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from pathlib import PurePosixPath
from uuid import UUID

import psycopg

from bl_worker.domain import FileKind
from bl_worker.labels import job
from bl_worker.labels.decide import decide, tier3_reason
from bl_worker.labels.domain import Draft, FileInfo, LabContext, Proposal, folder_of, norm
from bl_worker.labels.prompt import (
    LABEL_PROMPT_VERSION,
    NOTE_INSTRUCTIONS,
    InvalidOutput,
    NoteOutput,
    file_text,
    lab_context_text,
    page_roles,
    parse_label,
    proposal_json,
    source_text,
)
from bl_worker.labels.tier1 import Tier1, tier1
from bl_worker.model_cache import cached_call
from bl_worker.models import TIER2_MODEL, TIER3_MODEL, ModelRequest
from bl_worker.runtime import Runtime

log = logging.getLogger(__name__)

# Pages photographed one after another: each within this of the one before.
GAP = timedelta(minutes=10)
MAX_PAGES = 40
PAGE_CHARS = 900
NOTE_CHARS = 12000
# What a note page is, from its image description.
PAGE_KINDS = ("notebook page", "screen")
_PAGE_WORD = re.compile(r"\b(?:page|pg|p)\s?(\d{1,3})\b")
_LAST_NUMBER = re.compile(r"(\d{1,5})(?!.*\d)")


@dataclass(frozen=True)
class Page:
    sha256: str
    path: str
    modified_at: datetime
    file_kind: FileKind
    caption_kind: str | None = None
    batch: UUID | None = None


@dataclass(frozen=True)
class Group:
    origin: str
    reason: str
    pages: tuple[str, ...]


def page_number(path: str) -> int | None:
    """The page a file name says it is: "page 7", "p07", or a trailing number (IMG_4521)."""
    stem = norm(PurePosixPath(path).stem)
    m = _PAGE_WORD.search(stem) or _LAST_NUMBER.search(stem)
    return int(m[1]) if m else None


def _named_as_page(path: str) -> bool:
    return _PAGE_WORD.search(norm(PurePosixPath(path).stem)) is not None


def in_order(pages: Sequence[Page]) -> list[Page]:
    """By page number when every page has a distinct one, else by when it was taken."""
    numbers = [page_number(p.path) for p in pages]
    if None not in numbers and len(set(numbers)) == len(numbers):
        return [p for _, p in sorted(zip(numbers, pages, strict=True), key=lambda x: x[0])]  # type: ignore[arg-type,return-value]
    return sorted(pages, key=lambda p: (p.modified_at, p.path))


def _is_page(p: Page) -> bool:
    return p.file_kind in (FileKind.IMAGE, FileKind.PDF)


def group_pages(pages: Sequence[Page]) -> list[Group]:
    """Suggested notes: an upload batch of two or more photos, screenshots or PDFs; else, in
    one folder, notebook pages or files named as pages, each taken within GAP of the last."""
    groups: list[Group] = []
    taken: set[str] = set()
    batches: dict[UUID, list[Page]] = {}
    for p in pages:
        if p.batch is not None and _is_page(p):
            batches.setdefault(p.batch, []).append(p)
    for batch, members in batches.items():
        if 2 <= len(members) <= MAX_PAGES:
            ordered = in_order(members)
            groups.append(
                Group(f"batch:{batch}", "Uploaded together", tuple(p.sha256 for p in ordered))
            )
            taken |= {p.sha256 for p in members}

    folders: dict[str, list[Page]] = {}
    for p in pages:
        if p.sha256 in taken or not _is_page(p):
            continue
        if p.caption_kind in PAGE_KINDS or _named_as_page(p.path):
            folders.setdefault(folder_of(p.path), []).append(p)
    for folder, members in folders.items():
        run: list[Page] = []
        for p in sorted(members, key=lambda p: (p.modified_at, p.path)):
            if run and p.modified_at - run[-1].modified_at > GAP:
                groups += _folder_group(folder, run)
                run = []
            run.append(p)
        groups += _folder_group(folder, run)
    return groups


def _folder_group(folder: str, run: list[Page]) -> list[Group]:
    if not 2 <= len(run) <= MAX_PAGES:
        return []
    ordered = in_order(run)
    numbered = all(_named_as_page(p.path) for p in run)
    reason = "Numbered pages in one folder" if numbered else "Photographed within a few minutes"
    origin = f"folder:{folder}:{ordered[0].sha256[:16]}"
    return [Group(origin, reason, tuple(p.sha256 for p in ordered))]


CANDIDATE_PAGES = """
select distinct on (fl.sha256) fl.sha256, fl.path, fl.modified_at, b.file_kind,
  substring(c.content from '^Image \\(([^)]+)\\)'), u.batch_id
from file_locations fl
join blobs b on b.sha256 = fl.sha256
left join extractions c on c.sha256 = fl.sha256 and c.kind = 'image_caption'
left join uploads u on u.location_id = fl.id
where fl.lab_id = %(lab)s and fl.deleted_at is null and fl.index_state = 'indexed'
  and b.file_kind in ('image', 'pdf')
  and not exists (select 1 from note_pages np where np.lab_id = fl.lab_id and np.sha256 = fl.sha256)
order by fl.sha256, c.created_at desc nulls last, fl.modified_at desc
"""


def suggest_notes(conn: psycopg.Connection, lab_id: UUID) -> list[UUID]:
    """Creates suggested notes for groups not yet seen; returns the new notes. A file that was
    ever a page of a note, even a split one, isn't suggested again."""
    pages = [
        Page(sha, path, modified, FileKind(kind), caption_kind, batch)
        for sha, path, modified, kind, caption_kind, batch in conn.execute(
            CANDIDATE_PAGES, {"lab": lab_id}
        )
    ]
    created: list[UUID] = []
    for g in group_pages(pages):
        row = conn.execute(
            "insert into notes (lab_id, reason, origin) values (%s, %s, %s)"
            " on conflict (lab_id, origin) do nothing returning id",
            (lab_id, g.reason, g.origin),
        ).fetchone()
        if row is None:
            continue
        for position, sha in enumerate(g.pages, 1):
            conn.execute(
                "insert into note_pages (note_id, lab_id, sha256, position)"
                " values (%s, %s, %s, %s)",
                (row[0], lab_id, sha, position),
            )
        created.append(row[0])
    return created


def pages_key(shas: Sequence[str]) -> str:
    return hashlib.sha256(("note:" + ",".join(shas)).encode()).hexdigest()


def note_text(
    pages: Sequence[FileInfo], t1: Tier1, earlier: Proposal | None, tags: tuple[str, ...] = ()
) -> str:
    """The first page as file_text shows a file, then every page's words in order."""
    cover = replace(pages[0], text="", caption=None)
    lines = [file_text(cover, t1, None, tags), f"This note has {len(pages)} pages:"]
    budget = NOTE_CHARS
    for i, p in enumerate(pages, 1):
        body = "\n".join(t for t in (p.caption or "", p.text) if t)[: min(PAGE_CHARS, budget)]
        budget -= len(body)
        lines.append(f"--- Page {i} ({PurePosixPath(p.path).name}) ---\n{body or '(no text)'}")
    if earlier is not None:
        lines.append(
            "A faster model suggested this label; check it against everything above and "
            "correct anything that is wrong:\n" + json.dumps(proposal_json(earlier), sort_keys=True)
        )
    return "\n".join(lines)


def _ask_note(
    conn: psycopg.Connection,
    rt: Runtime,
    pages: Sequence[FileInfo],
    ctx: LabContext,
    t1: Tier1,
    model: str,
    earlier: Proposal | None,
    key: str,
    call_models: bool,
) -> tuple[Proposal | None, str | None]:
    request = ModelRequest(
        model=model,
        system=(NOTE_INSTRUCTIONS, lab_context_text(ctx)),
        content=(note_text(pages, t1, earlier, ctx.tags),),
        schema=NoteOutput,
        effort="low" if model == TIER2_MODEL else "medium",
        max_tokens=6000 if model == TIER2_MODEL else 10000,
    )
    text = cached_call(
        conn,
        rt.models,
        pages[0].lab_id,
        None,
        "note",
        request,
        LABEL_PROMPT_VERSION,
        call_models=call_models,
        cache_key=key,
    )
    if text is None:
        return None, None
    source = "\n".join(source_text(p) for p in pages)
    try:
        return (
            parse_label(
                text, ctx, model, source=source, kind=pages[0].file_kind, schema=NoteOutput
            ),
            text,
        )
    except InvalidOutput as e:
        log.warning("%s note label unusable: %s", model, e)
        return None, None


def label_note(rt: Runtime, note_id: UUID, *, call_models: bool = True) -> Draft | None:
    """Labels a note across its pages and writes the label on its first page. Waits (returns
    None) until every page has its own label, so each image is described first."""

    with rt.pool.connection() as conn:
        note = conn.execute(
            "select lab_id, state, labeled_cover from notes where id = %s", (note_id,)
        ).fetchone()
        if note is None or note[1] == "split":
            return None
        lab_id, _, old_cover = note
        shas = [
            r[0]
            for r in conn.execute(
                "select sha256 from note_pages where note_id = %s and live order by position",
                (note_id,),
            )
        ]
        if len(shas) < 2:
            return None
        labeled = conn.execute(
            "select count(*) from labels where lab_id = %s and sha256 = any(%s)", (lab_id, shas)
        ).fetchone()
        if labeled is None or labeled[0] < len(shas):
            return None
        pages = [job.load_file(conn, lab_id, s) for s in shas]
        if any(p is None for p in pages):
            return None
        files: list[FileInfo] = [p for p in pages if p is not None]
        if call_models:
            files = [job.ensure_caption(conn, rt, p) for p in files]
        ctx = job.load_context(conn, lab_id)
        cover = files[0]
        t1 = tier1(cover, ctx)
        key = pages_key(shas)
        proposal, text = _ask_note(conn, rt, files, ctx, t1, TIER2_MODEL, None, key, call_models)
        if rt.models is not None or not call_models:
            why = tier3_reason(cover, t1, proposal)
            if why is not None:
                better, better_text = _ask_note(
                    conn, rt, files, ctx, t1, TIER3_MODEL, proposal, key, call_models
                )
                if better is not None:
                    proposal, text = better, better_text
        asked = (
            text is not None
            or conn.execute(
                "select 1 from model_calls where lab_id = %s and cache_key = %s"
                " and purpose = 'note'",
                (lab_id, key),
            ).fetchone()
            is not None
        )
        draft = decide(
            t1, proposal, file=cover, prompt_version=LABEL_PROMPT_VERSION if asked else None
        )
        draft = job.distinct_title(conn, cover, draft)
        job.write_label(conn, lab_id, cover.sha256, draft)
        roles = page_roles(text, len(shas)) if text else {}
        for position, role in roles.items():
            conn.execute(
                "update note_pages set role = %s where note_id = %s and position = %s and live",
                (role, note_id, position),
            )
        conn.execute(
            "update notes set labeled_key = %s, labeled_cover = %s where id = %s",
            (key, cover.sha256, note_id),
        )
    # A page that used to carry the note's label goes back to its own.
    if old_cover is not None and old_cover != cover.sha256:
        job.label_blob(rt, lab_id, old_cover)
    return draft


NOTES_TO_LABEL = """
select n.lab_id, n.id from notes n
join labs l on l.id = n.lab_id and l.deletion_requested_at is null
where n.state <> 'split'
  and n.labeled_key is distinct from encode(sha256(convert_to('note:' || (
    select string_agg(p.sha256, ',' order by p.position) from note_pages p
    where p.note_id = n.id and p.live), 'utf8')), 'hex')
  and (select count(*) from note_pages p where p.note_id = n.id and p.live) = (
    select count(*) from note_pages p
    join labels lb on lb.lab_id = p.lab_id and lb.sha256 = p.sha256
    where p.note_id = n.id and p.live)
order by n.created_at limit %s
"""


def tend_notes(rt: Runtime, *, limit: int = 20) -> list[tuple[UUID, UUID]]:
    """Suggests new notes in every lab, sends the first page of each split note back to its own
    label, and returns the notes whose label is out of date."""
    with rt.pool.connection() as conn:
        labs = [
            r[0]
            for r in conn.execute(
                "select id from labs where deletion_requested_at is null order by created_at"
            )
        ]
        for lab_id in labs:
            with conn.transaction():
                suggest_notes(conn, lab_id)
        split = conn.execute(
            "update notes n set labeled_cover = null, labeled_key = null from (select id,"
            " labeled_cover from notes where state = 'split' and labeled_cover is not null"
            " for update) old where n.id = old.id returning n.lab_id, old.labeled_cover"
        ).fetchall()
        todo = [(r[0], r[1]) for r in conn.execute(NOTES_TO_LABEL, (limit,))]
    for lab_id, sha in split:
        job.label_blob(rt, lab_id, sha)
    return todo
