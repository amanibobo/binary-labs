"""A gentle re-label sweep: labels made under an older label prompt are labeled again, a few
at a time, so existing files get outcomes, summaries and conditions without a burst of model
calls. Model answers are cached by content and prompt version, so a file whose content hasn't
changed is paid for at most once per prompt version; a label a person confirmed keeps every
value they saw and only gains the new fields."""

from __future__ import annotations

from uuid import UUID

import psycopg

from bl_worker.labels.prompt import LABEL_PROMPT_VERSION

# Per 10 s tick: about 30 files a minute, or a 1,000-file lab in about half an hour.
PER_TICK = 5

# Labels from an older prompt, oldest first, in labs not being deleted. Rules-only labels
# (made while no model was set up) are the unlabeled sweep's; needs-a-look labels and labels
# on files no longer in the lab are skipped.
STALE = """
select l.lab_id, l.sha256 from labels l
join labs lab on lab.id = l.lab_id and lab.deletion_requested_at is null
where coalesce(l.prompt_version, 0) < %(version)s
  and (l.source <> 'rules' or l.status in ('accepted', 'corrected'))
  and l.status <> 'needs_look'
  and exists (select 1 from file_locations fl where fl.lab_id = l.lab_id
    and fl.sha256 = l.sha256 and fl.deleted_at is null and fl.index_state = 'indexed')
order by l.updated_at, l.sha256
limit %(limit)s
"""


def stale_labels(
    conn: psycopg.Connection, *, limit: int = PER_TICK, version: int = LABEL_PROMPT_VERSION
) -> list[tuple[UUID, str]]:
    return [(r[0], r[1]) for r in conn.execute(STALE, {"version": version, "limit": limit})]
