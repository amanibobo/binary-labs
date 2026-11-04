import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { FolderPath, ROOT_FOLDER, type BrowseResponse } from "@/lib/folders";
import { loadFolderFiles } from "@/lib/lab-data";
import { logError } from "@/lib/log";
import { routeAccess } from "@/lib/route-auth";

const PG_INT_MAX = 2_147_483_647;

const BrowseParams = z.object({
  path: FolderPath.default(ROOT_FOLDER),
  offset: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().max(PG_INT_MAX))
    .default(0),
});

export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const params = BrowseParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) return NextResponse.json({ error: "invalid browse parameters" }, { status: 400 });

  let body: BrowseResponse;
  try {
    body = { files: await loadFolderFiles(supabase, lab.id, params.data.path, params.data.offset) };
  } catch (error) {
    logError("browse.failed", { labId: lab.id, error });
    return NextResponse.json({ error: "browse failed" }, { status: 500 });
  }
  return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
}
