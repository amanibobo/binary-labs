import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { listFolders } from "@/lib/dropbox";
import { sourceAccessToken } from "@/lib/dropbox-session";
import { loadSourceState } from "@/lib/lab-data";
import { logError } from "@/lib/log";
import { routeAccess } from "@/lib/route-auth";

const Path = z.union([z.literal(""), z.string().startsWith("/").max(1000)]);

export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: true });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const path = Path.safeParse(request.nextUrl.searchParams.get("path") ?? "");
  if (!path.success) return NextResponse.json({ error: "invalid path" }, { status: 400 });

  const source = await loadSourceState(supabase, lab.id);
  if (source.kind === "not_connected") return NextResponse.json({ error: "connect Dropbox first" }, { status: 409 });

  try {
    const token = await sourceAccessToken({ labId: lab.id, sourceId: source.sourceId });
    return NextResponse.json({ path: path.data, folders: await listFolders(token, path.data) });
  } catch (error) {
    logError("dropbox.list_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "couldn't list folders" }, { status: 502 });
  }
}
