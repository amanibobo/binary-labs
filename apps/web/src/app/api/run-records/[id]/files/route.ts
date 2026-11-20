import type { NextRequest } from "next/server";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson } from "@/lib/route-auth";
import { AddFilesRequest, RemoveFileRequest } from "@/lib/run-record";
import { addRunFiles, removeRunFile, runError } from "@/lib/run-record-store";
import { runAccess } from "@/lib/run-routes";

// POST adds files to the run, or changes the role of ones it has. DELETE takes one out; the
// file itself is untouched.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/files">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = AddFilesRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await addRunFiles(supabase, access.id, body.data.shas, body.data.role);
  if (written.kind === "error") return runError(written.error, { event: "run.add_files_failed", labId: lab.id });
  return ok(written.value);
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/run-records/[id]/files">) {
  const access = await runAccess(ctx.params);
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = RemoveFileRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await removeRunFile(supabase, access.id, body.data.sha256);
  if (written.kind === "error") return runError(written.error, { event: "run.remove_file_failed", labId: lab.id });
  return ok(written.value);
}
