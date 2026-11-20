import type { NextRequest } from "next/server";
import { z } from "zod";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { CreateRunRequest, RunListFilter } from "@/lib/run-record";
import { createRun, loadLabRuns, runError } from "@/lib/run-record-store";

const Offset = z.coerce.number().int().min(0).max(100000).catch(0);

// GET lists the lab's runs, newest first, a page at a time (?status=, ?technique=, ?step=,
// ?cause=, ?experimentId=, ?offset=). The charts' files-as-runs route is /api/runs.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const filter = RunListFilter.safeParse(params);
  if (!filter.success) return badRequest(filter.error);
  return ok({ runs: await loadLabRuns(supabase, lab.id, filter.data, Offset.parse(params.offset)) });
}

// POST makes a run from the files a person picked.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = CreateRunRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  const written = await createRun(supabase, lab.id, body.data.shas, body.data.fields);
  if (written.kind === "error") return runError(written.error, { event: "run.create_failed", labId: lab.id });
  return ok(written.value);
}
