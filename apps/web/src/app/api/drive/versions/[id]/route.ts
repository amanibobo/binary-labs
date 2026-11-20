import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { VersionId } from "@/lib/drive";
import { Sha256 } from "@/lib/ids";
import { routeAccess } from "@/lib/route-auth";
import { openOriginal } from "@/lib/serve-original";
import { unwrap } from "@/lib/supabase/server";

const VersionRow = z.object({
  sha256: Sha256,
  original_name: z.string(),
  kept_at: z.string().nullable(),
  blobs: z.object({ mime: z.string() }).nullable(),
});

// Opens one version of a file as it was: its own bytes from our store, wherever the file
// lives, checked against the version's sha256 before anything is sent.
export async function GET(request: NextRequest, ctx: RouteContext<"/api/drive/versions/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;

  const id = VersionId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid version id" }, { status: 400 });

  // Read with the user's session: RLS decides whether this lab may see the version, and a
  // version of a file deleted from the lab's folder isn't shown. The key is built from the
  // viewer's own lab, never from the request.
  const rows = z.array(VersionRow).parse(
    unwrap(
      await supabase
        .from("file_versions")
        .select("sha256, original_name, kept_at, blobs(mime), file_locations!inner(deleted_at)")
        .eq("id", id.data)
        .eq("lab_id", lab.id)
        .is("file_locations.deleted_at", null)
        .limit(1),
    ),
  );
  const row = rows[0];
  if (row === undefined) return NextResponse.json({ error: "no such version" }, { status: 404 });
  if (row.kept_at === null) return NextResponse.json({ error: "Binary doesn't have this version's file." }, { status: 404 });

  return openOriginal(request, { supabase, labId: lab.id, userId: user.id, sha256: row.sha256, name: row.original_name, mime: row.blobs?.mime ?? null, what: "version" });
}
