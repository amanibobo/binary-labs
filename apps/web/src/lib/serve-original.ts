import "server-only";
import { after, NextResponse } from "next/server";
import { auditQuietly } from "./audit";
import { startsAtBeginning } from "./byte-range";
import type { LabId, Sha256, UserId } from "./ids";
import { logError } from "./log";
import { deliverObject, readObject } from "./object-store";
import { fileResponse } from "./serve-file";
import type { Supabase } from "./supabase/server";
import { deliveryFor, uploadKey } from "./uploads";
import { bytesMatch } from "./version-open";

const noStore = { "cache-control": "private, no-store" };

// Hands over a file's own kept bytes from our store at <lab_id>/files/<sha256>, checked
// against the sha256 before anything is sent, and audits the open. The caller has already
// decided this member may see this content; the key is built from their own lab.
export async function openOriginal(
  request: Request,
  file: { supabase: Supabase; labId: LabId; userId: UserId; sha256: Sha256; name: string; mime: string | null; what: "version" | "file" },
): Promise<Response> {
  const key = uploadKey(file.labId, file.sha256);
  const headers = deliveryFor(file.mime, file.name);
  const delivery = await deliverObject(key, headers);
  if (delivery.kind === "missing") {
    logError("original.missing", { labId: file.labId, sha256: file.sha256 });
    return NextResponse.json({ error: `This ${file.what}'s file is missing from storage.` }, { status: 404 });
  }
  // A range request continues a file this check already passed at its start.
  const range = request.headers.get("range");
  if (startsAtBeginning(range)) {
    if (!(await bytesMatch(await readObject(key), file.sha256))) {
      logError("original.hash_mismatch", { labId: file.labId, sha256: file.sha256 });
      return NextResponse.json({ error: `This ${file.what}'s stored file doesn't match what Binary read, so it wasn't opened.` }, { status: 500 });
    }
    after(() => auditQuietly(file.supabase, { labId: file.labId, actor: file.userId, action: "file.download", target: file.sha256 }));
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
