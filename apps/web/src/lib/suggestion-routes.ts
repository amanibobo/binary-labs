import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ProtocolId } from "./ids";
import { logError } from "./log";
import type { ApproveOutcome, ApproveRequest } from "./suggestions";
import type { LabId, SuggestionId } from "./ids";
import type { Supabase } from "./supabase/server";

// Approving and dismissing, as the member: approve_protocol_suggestion saves through
// save_protocol and approve_label_suggestion through correct_label, so the version or the
// corrections are theirs, and the audit log says who decided.

const NO_STORE = { "cache-control": "private, no-store" };

type DbError = { code?: string; message: string };

export function suggestionError(error: DbError, ctx: { event: string; labId: LabId }): NextResponse {
  switch (error.code) {
    case "BL101":
      return NextResponse.json({ kind: "stale" } satisfies ApproveOutcome, { status: 409, headers: NO_STORE });
    case "BL601":
      return NextResponse.json({ error: "Someone already approved or dismissed this suggestion." }, { status: 409 });
    case "BL602":
      return NextResponse.json({ error: "Pick at least one file from this suggestion." }, { status: 400 });
    case "BL102":
      return NextResponse.json({ error: "This protocol is archived." }, { status: 409 });
    case "23503":
      return NextResponse.json({ error: "Pick an experiment and a person from the lab's lists." }, { status: 400 });
    case "BL001":
      return NextResponse.json({ error: "One of these files has no label yet." }, { status: 409 });
    case "23514":
    case "22023":
      return NextResponse.json({ error: "Check the title and text, then try again." }, { status: 400 });
    default:
      logError(ctx.event, { labId: ctx.labId, error });
      return NextResponse.json({ error: "We couldn't save that. Try again." }, { status: 500 });
  }
}

const SavedRows = z.array(z.object({ protocol_id: ProtocolId, version: z.number().int().positive() })).length(1);
const AppliedRows = z.array(z.object({ sha256: z.string(), correction_id: z.number() }));

export async function approve(
  supabase: Supabase,
  { labId, id, req }: { labId: LabId; id: SuggestionId; req: z.output<typeof ApproveRequest> },
): Promise<NextResponse> {
  switch (req.kind) {
    case "protocol_edit": {
      const { data, error } = await supabase.rpc("approve_protocol_suggestion", {
        p_id: id,
        p_title: req.edit?.title ?? null,
        p_body: req.edit?.body ?? null,
        p_note: req.edit === null ? null : req.edit.note === null || req.edit.note === "" ? null : req.edit.note,
      });
      if (error !== null) return suggestionError(error, { event: "suggestions.approve_failed", labId });
      const [row] = SavedRows.parse(data);
      return NextResponse.json(
        { kind: "approved", protocolId: row?.protocol_id ?? null, version: row?.version ?? null, applied: 1 } satisfies ApproveOutcome,
        { headers: NO_STORE },
      );
    }
    case "labels": {
      const { data, error } = await supabase.rpc("approve_label_suggestion", {
        p_id: id,
        p_shas: req.shas,
        p_edits: req.edits.map((e) => ({ sha256: e.sha256, clean_name: e.cleanName, date: e.date, experiment_id: e.experimentId, person_id: e.personId })),
      });
      if (error !== null) return suggestionError(error, { event: "suggestions.approve_failed", labId });
      const applied = AppliedRows.parse(data).length;
      return NextResponse.json({ kind: "approved", protocolId: null, version: null, applied } satisfies ApproveOutcome, { headers: NO_STORE });
    }
    default: {
      const _exhaustive: never = req;
      return _exhaustive;
    }
  }
}
