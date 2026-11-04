import { after, NextResponse, type NextRequest } from "next/server";
import { embedConfig } from "@/env";
import { auditQuietly } from "@/lib/audit";
import { SearchParams, type SearchResponse } from "@/lib/domain";
import { logError } from "@/lib/log";
import { routeAccess } from "@/lib/route-auth";
import { embedQuery, searchWithFallback } from "@/lib/search";
import { unwrap } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;

  const params = SearchParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) return NextResponse.json({ error: "invalid search parameters" }, { status: 400 });

  const config = embedConfig();
  let body: SearchResponse;
  try {
    body = await searchWithFallback({
      labId: lab.id,
      params: params.data,
      embed: (text) => embedQuery({ config, text }),
      searchFiles: async (args) => unwrap(await supabase.rpc("search_files", args)),
    });
  } catch (error) {
    logError("search.failed", { labId: lab.id, error });
    return NextResponse.json({ error: "search failed" }, { status: 500 });
  }

  after(() => auditQuietly(supabase, { labId: lab.id, actor: user.id, action: "search", target: params.data.q }));
  return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
}
