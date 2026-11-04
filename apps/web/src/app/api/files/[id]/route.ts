import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auditQuietly } from "@/lib/audit";
import { SourceKind } from "@/lib/domain";
import { LocationId, Sha256 } from "@/lib/ids";
import { deliverObject } from "@/lib/object-store";
import { routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";
import { deliveryFor, uploadKey } from "@/lib/uploads";

const FileRow = z.object({
  external_id: z.string(),
  original_name: z.string(),
  sources: z.object({ kind: SourceKind }),
  blobs: z.object({ mime: z.string() }).nullable(),
});

// Opens a file we hold: today that's an upload. Dropbox files open in Dropbox instead.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/files/[id]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;

  const id = LocationId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "invalid file id" }, { status: 400 });

  // Read with the user's session: RLS decides whether this lab may see the location, and the
  // storage key is built from the viewer's own lab, never from the request.
  const rows = z.array(FileRow).parse(
    unwrap(
      await supabase
        .from("file_locations")
        .select("external_id, original_name, sources!inner(kind), blobs(mime)")
        .eq("id", id.data)
        .eq("lab_id", lab.id)
        .is("deleted_at", null)
        .limit(1),
    ),
  );
  const row = rows[0];
  const sha = Sha256.safeParse(row?.external_id);
  if (row === undefined || row.sources.kind !== "upload" || !sha.success) {
    return NextResponse.json({ error: "no such file" }, { status: 404 });
  }

  const headers = deliveryFor(row.blobs?.mime ?? null, row.original_name);
  const delivery = await deliverObject(uploadKey(lab.id, sha.data), headers);
  after(() => auditQuietly(supabase, { labId: lab.id, actor: user.id, action: "file.download", target: sha.data }));
  switch (delivery.kind) {
    case "redirect":
      return NextResponse.redirect(delivery.url, { status: 302, headers: { "cache-control": "private, no-store" } });
    case "bytes":
      return new NextResponse(delivery.body, {
        headers: {
          "content-type": headers.contentType,
          "content-disposition": headers.disposition,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    case "missing":
      return NextResponse.json({ error: "file missing from storage" }, { status: 404 });
    default: {
      const _exhaustive: never = delivery;
      return _exhaustive;
    }
  }
}
