import type { NextRequest } from "next/server";
import { CreateEntryRequest } from "@/lib/calendar";
import { createEntry, entryError } from "@/lib/calendar-store";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";

// POST a draft and how it repeats: a new entry on the lab's calendar, made by the caller.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = CreateEntryRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await createEntry(supabase, lab.id, body.data);
  if (written.kind === "error") return entryError(written.error, { event: "calendar.create_failed", labId: lab.id });
  return ok(written.entry);
}
