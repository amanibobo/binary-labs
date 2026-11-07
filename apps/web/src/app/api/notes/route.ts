import { NextResponse, type NextRequest } from "next/server";
import { logError } from "@/lib/log";
import { noteFailure, NoteRequest, noteRpc } from "@/lib/notes";
import { readJson, routeAccess } from "@/lib/route-auth";

// Keep, split (and undo a split), take a page out of, or join a note. The functions check the
// caller is a member and write the audit row themselves.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const body = NoteRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "Check the note and try again." }, { status: 400 });

  const call = noteRpc(lab.id, body.data);
  const { data, error } = await supabase.rpc(call.fn, call.args);
  if (error !== null) {
    const failure = noteFailure(error);
    if (failure.status === 500) logError("notes.change_failed", { labId: lab.id, action: body.data.action, error });
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ noteId: typeof data === "string" ? data : null }, { headers: { "cache-control": "private, no-store" } });
}
