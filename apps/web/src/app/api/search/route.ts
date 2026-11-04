import { after, NextResponse, type NextRequest } from "next/server";
import { embedConfig } from "@/env";
import { auditQuietly } from "@/lib/audit";
import { SearchParams, type SearchResponse } from "@/lib/domain";
import { hasFilters } from "@/lib/filters";
import { logError } from "@/lib/log";
import { PROTOCOL_HITS_SHOWN, SearchProtocolsRows, type ProtocolHit } from "@/lib/protocols";
import { routeAccess } from "@/lib/route-auth";
import { embedQuery, searchWithFallback } from "@/lib/search";
import { unwrap, type Supabase } from "@/lib/supabase/server";
import type { LabId } from "@/lib/ids";

// File filters (kind, folder, dates) describe files, so a filtered search shows no pages.
async function searchProtocols(supabase: Supabase, labId: LabId, params: SearchParams): Promise<ProtocolHit[]> {
  const { q, ...filters } = params;
  if (hasFilters(filters)) return [];
  return SearchProtocolsRows.parse(
    unwrap(await supabase.rpc("search_protocols", { p_lab_id: labId, p_query: q, p_limit: PROTOCOL_HITS_SHOWN })),
  );
}

export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;

  const params = SearchParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) return NextResponse.json({ error: "invalid search parameters" }, { status: 400 });

  const config = embedConfig();
  let body: SearchResponse;
  try {
    const [files, protocols] = await Promise.all([
      searchWithFallback({
        labId: lab.id,
        params: params.data,
        embed: (text) => embedQuery({ config, text }),
        searchFiles: async (args) => unwrap(await supabase.rpc("search_files", args)),
      }),
      searchProtocols(supabase, lab.id, params.data),
    ]);
    body = { ...files, protocols };
  } catch (error) {
    logError("search.failed", { labId: lab.id, error });
    return NextResponse.json({ error: "search failed" }, { status: 500 });
  }

  after(() => auditQuietly(supabase, { labId: lab.id, actor: user.id, action: "search", target: params.data.q }));
  return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
}
