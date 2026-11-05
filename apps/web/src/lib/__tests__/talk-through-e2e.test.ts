import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { talkThroughHeaders } from "../talk-throughs";
import { localDay } from "../uploads";

// Driven by scripts/e2e-talk-through.sh, which sets these and then runs the real worker.
// Skipped in the normal unit run.
const env = z
  .object({
    E2E_DATABASE_URL: z.string(),
    E2E_USER: z.string().min(1),
    E2E_LAB: z.string().min(1),
    E2E_AUDIO: z.string().min(1),
  })
  .safeParse(process.env);

vi.mock("server-only", () => ({}));

describe.runIf(env.success)("sending a recorded talk-through through the route's core", () => {
  it("stores the audio and starts the talk-through", async () => {
    if (!env.success) return;
    const { E2E_DATABASE_URL, E2E_USER, E2E_LAB, E2E_AUDIO } = env.data;
    const { acceptTalkThrough } = await import("../upload-accept");
    const db = new Client({ connectionString: E2E_DATABASE_URL });
    await db.connect();
    try {
      const bytes = readFileSync(E2E_AUDIO);
      const headers = new Headers({
        "content-type": "audio/mp4",
        "content-length": String(bytes.byteLength),
        ...talkThroughHeaders({
          name: basename(E2E_AUDIO),
          uploadedOn: localDay(new Date()),
          modifiedAt: null,
          durationMs: null,
          target: { kind: "new", pageKind: "protocol" },
        }),
      });
      const accepted = await acceptTalkThrough({ headers, body: new Blob([bytes]).stream() }, E2E_LAB, async (args) => {
        await db.query("begin");
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: E2E_USER })]);
        const res = await db.query(
          "select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from record_talk_through($1, $2, $3, $4, $5::date, $6::timestamptz, $7::protocol_kind, $8, $9, $10) r",
          [
            args.p_lab_id,
            args.p_sha256,
            args.p_size,
            args.p_name,
            args.p_uploaded_on,
            args.p_modified_at,
            args.p_kind,
            args.p_protocol_id,
            args.p_base_version_id,
            args.p_duration_ms,
          ],
        );
        await db.query("commit");
        return { data: res.rows[0]?.rows, error: null };
      });
      process.stdout.write(`${JSON.stringify(accepted)}\n`);
      expect(accepted.status).toBe(201);
    } finally {
      await db.end();
    }
  });
});
