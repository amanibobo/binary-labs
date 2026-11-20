import type { NextRequest } from "next/server";
import { z } from "zod";
import { Sha256 } from "@/lib/ids";
import { badRequest, ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";
import { loadFileRuns } from "@/lib/run-record-store";

const Query = z.object({ sha256: z.array(Sha256).min(1).max(200) });

// GET ?sha256=…&sha256=… is the run each of those files belongs to, for the ones that have one.
export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const query = Query.safeParse({ sha256: request.nextUrl.searchParams.getAll("sha256") });
  if (!query.success) return badRequest(query.error);
  return ok({ runs: await loadFileRuns(supabase, lab.id, query.data.sha256) });
}
