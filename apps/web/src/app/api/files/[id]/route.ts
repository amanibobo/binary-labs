import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auditQuietly } from "@/lib/audit";
import { startsAtBeginning } from "@/lib/byte-range";
import { SourceKind } from "@/lib/domain";
import { temporaryLink } from "@/lib/dropbox";
import { sourceAccessToken } from "@/lib/dropbox-session";
import { LocationId, Sha256, SourceId } from "@/lib/ids";
import { logError } from "@/lib/log";
import { deliverObject } from "@/lib/object-store";
import { routeAccess } from "@/lib/route-auth";
import { fileResponse } from "@/lib/serve-file";
import { unwrap } from "@/lib/supabase/server";
import { deliveryFor, uploadKey } from "@/lib/uploads";
import { VideoType } from "@/lib/videos";

const FileRow = z.object({
  external_id: z.string(),
  original_name: z.string(),
  source_id: SourceId,
  sources: z.object({ kind: SourceKind }),
  blobs: z.object({ mime: z.string() }).nullable(),
});

const noStore = { "cache-control": "private, no-store" };

// Opens a file: an upload from our store, or a lab's Dropbox video through a temporary link
// so it plays on its protocol page. Other Dropbox files open in Dropbox instead. A video
// element asks for ranges as it plays; only the request that starts the file is audited.
export async function GET(request: NextRequest, ctx: RouteContext<"/api/files/[id]">) {
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
        .select("external_id, original_name, source_id, sources!inner(kind), blobs(mime)")
        .eq("id", id.data)
        .eq("lab_id", lab.id)
        .is("deleted_at", null)
        .limit(1),
    ),
  );
  const row = rows[0];
  if (row === undefined) return NextResponse.json({ error: "no such file" }, { status: 404 });
  const range = request.headers.get("range");
  const audit = (target: string) => {
    if (startsAtBeginning(range)) {
      after(() => auditQuietly(supabase, { labId: lab.id, actor: user.id, action: "file.download", target }));
    }
  };

  switch (row.sources.kind) {
    case "upload": {
      const sha = Sha256.safeParse(row.external_id);
      if (!sha.success) return NextResponse.json({ error: "no such file" }, { status: 404 });
      const headers = deliveryFor(row.blobs?.mime ?? null, row.original_name);
      const delivery = await deliverObject(uploadKey(lab.id, sha.data), headers);
      switch (delivery.kind) {
        case "redirect":
          audit(sha.data);
          return NextResponse.redirect(delivery.url, { status: 302, headers: noStore });
        case "file":
          audit(sha.data);
          return fileResponse({
            path: delivery.path,
            size: delivery.size,
            range,
            headers: {
              "content-type": headers.contentType,
              "content-disposition": headers.disposition,
              "x-content-type-options": "nosniff",
              ...noStore,
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
    case "dropbox": {
      if (!VideoType.safeParse(row.blobs?.mime).success) {
        return NextResponse.json({ error: "this file opens in Dropbox" }, { status: 404 });
      }
      try {
        const token = await sourceAccessToken({ labId: lab.id, sourceId: row.source_id });
        const link = await temporaryLink(token, row.external_id);
        audit(row.external_id);
        return NextResponse.redirect(link, { status: 302, headers: noStore });
      } catch (error) {
        logError("dropbox.temporary_link_failed", { labId: lab.id, error });
        return NextResponse.json({ error: "Dropbox didn't hand us this video. Open it in Dropbox." }, { status: 502 });
      }
    }
    case "local":
      return NextResponse.json({ error: "no such file" }, { status: 404 });
    default: {
      const _exhaustive: never = row.sources.kind;
      return _exhaustive;
    }
  }
}
