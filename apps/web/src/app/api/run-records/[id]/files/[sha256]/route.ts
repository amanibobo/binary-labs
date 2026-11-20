import { NextResponse, type NextRequest } from "next/server";
import { Sha256 } from "@/lib/ids";
import { loadRunFile } from "@/lib/run-record-store";
import { runAccess } from "@/lib/run-routes";
import { openOriginal } from "@/lib/serve-original";

// Opens one of a run's files exactly as Binary read it: its own kept bytes, checked against
// its sha256 before anything is sent. The run holds its files, so this still works after the
// file is edited or removed in the lab's folder.
export async function GET(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/files/[sha256]">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;
  const sha256 = Sha256.safeParse((await ctx.params).sha256);
  if (!sha256.success) return NextResponse.json({ error: "That file isn't in this run." }, { status: 404 });

  const file = await loadRunFile(supabase, access.id, sha256.data);
  if (file === null) return NextResponse.json({ error: "That file isn't in this run." }, { status: 404 });
  if (!file.kept) return NextResponse.json({ error: "Binary is still saving its copy of this file. Try again in a few minutes." }, { status: 404 });
  return openOriginal(request, { supabase, labId: lab.id, userId: user.id, sha256: sha256.data, name: file.originalName, mime: file.mime, what: "file" });
}
