import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auditQuietly } from "@/lib/audit";
import { startsAtBeginning } from "@/lib/byte-range";
import { VersionId } from "@/lib/drive";
import { Sha256 } from "@/lib/ids";
import { logError } from "@/lib/log";
import { deliverObject, readObject } from "@/lib/object-store";
import { routeAccess } from "@/lib/route-auth";
import { fileResponse } from "@/lib/serve-file";
import { unwrap } from "@/lib/supabase/server";
import { deliveryFor, uploadKey } from "@/lib/uploads";
import { bytesMatch } from "@/lib/version-open";

const VersionRow = z.object({
  sha256: Sha256,
  original_name: z.string(),
  kept_at: z.string().nullable(),
  blobs: z.object({ mime: z.string() }).nullable(),
});

const noStore = { "cache-control": "private, no-store" };

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

  const key = uploadKey(lab.id, row.sha256);
  const headers = deliveryFor(row.blobs?.mime ?? null, row.original_name);
  const delivery = await deliverObject(key, headers);
  if (delivery.kind === "missing") {
    logError("version.missing", { labId: lab.id, version: id.data });
    return NextResponse.json({ error: "This version's file is missing from storage." }, { status: 404 });
  }
  // A range request continues a file this check already passed at its start.
  const range = request.headers.get("range");
  if (startsAtBeginning(range)) {
    if (!(await bytesMatch(await readObject(key), row.sha256))) {
      logError("version.hash_mismatch", { labId: lab.id, version: id.data, sha256: row.sha256 });
      return NextResponse.json({ error: "This version's stored file doesn't match what Binary read, so it wasn't opened." }, { status: 500 });
    }
    after(() => auditQuietly(supabase, { labId: lab.id, actor: user.id, action: "file.download", target: row.sha256 }));
  }
  switch (delivery.kind) {
    case "redirect":
      return NextResponse.redirect(delivery.url, { status: 302, headers: noStore });
    case "file":
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
    default: {
      const _exhaustive: never = delivery;
      return _exhaustive;
    }
  }
}
