import { NextResponse, type NextRequest } from "next/server";
import { CalendarEntryId, DeleteEntryRequest, SaveEntryRequest } from "@/lib/calendar";
import { deleteEntry, entryError, saveEntry } from "@/lib/calendar-store";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// POST saves over the entry, unless someone saved it since the editor loaded it (409, with
// theirs, or null when they deleted it). Scope "all" saves it to every occurrence of its series.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/calendar/entries/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = CalendarEntryId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid entry id" }, { status: 400 });
  const body = SaveEntryRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const saved = await saveEntry(supabase, lab.id, id.data, body.data);
  if (saved.kind === "error") return entryError(saved.error, { event: "calendar.save_failed", labId: lab.id });
  if (saved.outcome.kind === "stale") return NextResponse.json(saved.outcome, { status: 409, headers: { "cache-control": "private, no-store" } });
  return ok(saved.outcome);
}

// DELETE with { scope }: the entry, or every occurrence of its series.
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/calendar/entries/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const id = CalendarEntryId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid entry id" }, { status: 400 });
  const body = DeleteEntryRequest.safeParse((await readJson(request)) ?? {});
  if (!body.success) return badRequest(body.error);
  const deleted = await deleteEntry(supabase, lab.id, id.data, body.data.scope);
  if (deleted.kind === "error") return entryError(deleted.error, { event: "calendar.delete_failed", labId: lab.id });
  return ok({});
}
