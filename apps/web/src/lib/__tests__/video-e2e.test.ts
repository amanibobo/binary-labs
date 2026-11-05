import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProtocolId } from "../ids";
import { localDay } from "../uploads";
import { partCount, partSpan } from "../parts";

// Driven by scripts/e2e-video.sh, which sets these and then runs the real worker. Skipped in
// the normal unit run.
const env = z
  .object({
    E2E_DATABASE_URL: z.string(),
    E2E_USER: z.string().min(1),
    E2E_LAB: z.string().min(1),
    E2E_PROTOCOL: z.string().min(1),
    E2E_VIDEO: z.string().min(1),
  })
  .safeParse(process.env);

vi.mock("server-only", () => ({}));

describe.runIf(env.success)("sending a video to a page through the upload routes' core", () => {
  it("sends it in parts, checks it, and records it for the page", async () => {
    if (!env.success) return;
    const { E2E_DATABASE_URL, E2E_USER, E2E_LAB, E2E_PROTOCOL, E2E_VIDEO } = env.data;
    const { completeVideoUpload, receiveVideoPart, startVideoUpload } = await import("../video-upload");
    const db = new Client({ connectionString: E2E_DATABASE_URL });
    await db.connect();
    try {
      const bytes = readFileSync(E2E_VIDEO);
      const name = basename(E2E_VIDEO);
      const request = { protocolId: ProtocolId.parse(E2E_PROTOCOL), name, size: bytes.byteLength, type: "video/mp4" as const };
      const started = await startVideoUpload(E2E_LAB, request, async () => "open");
      if (!("session" in started)) throw new Error(started.error);
      const parts = [];
      for (let n = 1; n <= partCount(bytes.byteLength); n++) {
        const span = partSpan(bytes.byteLength, n);
        const part = bytes.subarray(span.start, span.end);
        const put = await receiveVideoPart(E2E_LAB, started.session.uploadId, n, {
          headers: new Headers({ "content-length": String(part.byteLength) }),
          body: new Blob([new Uint8Array(part)]).stream(),
        });
        if (!("etag" in put)) throw new Error(put.error);
        parts.push({ partNumber: n, etag: put.etag });
      }
      const done = await completeVideoUpload(
        E2E_LAB,
        started.session.uploadId,
        {
          ...request,
          storeId: started.session.storeId,
          parts,
          uploadedOn: localDay(new Date()),
          modifiedAt: null,
        },
        async (args) => {
          await db.query("begin");
          await db.query("set local role authenticated");
          await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: E2E_USER })]);
          const res = await db.query(
            "select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from record_video($1, $2, $3, $4, $5::date, $6::timestamptz, $7) r",
            [args.p_lab_id, args.p_sha256, args.p_size, args.p_name, args.p_uploaded_on, args.p_modified_at, args.p_protocol_id],
          );
          await db.query("commit");
          return { data: res.rows[0]?.rows, error: null };
        },
      );
      process.stdout.write(`${JSON.stringify(done)}\n`);
      expect(done).toMatchObject({ status: 201, receipt: { linked: false } });
    } finally {
      await db.end();
    }
  });
});
