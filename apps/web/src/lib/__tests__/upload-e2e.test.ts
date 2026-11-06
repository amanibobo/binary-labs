import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { localDay, uploadHeaders } from "../uploads";

// Driven by scripts/e2e-upload.sh, which sets these and then runs the real worker. Skipped
// in the normal unit run.
const env = z
  .object({
    E2E_DATABASE_URL: z.string(),
    E2E_USER: z.string().min(1),
    E2E_LAB: z.string().min(1),
    E2E_FILES: z.string().transform((s) => s.split(",")),
    E2E_EXPERIMENT: z.string(),
  })
  .safeParse(process.env);

vi.mock("server-only", () => ({}));

describe.runIf(env.success)("uploading sample files through the route's core", () => {
  it("stores and records each file", async () => {
    if (!env.success) return;
    const { E2E_DATABASE_URL, E2E_USER, E2E_LAB, E2E_FILES, E2E_EXPERIMENT } = env.data;
    const { sendUpload } = await import("./upload-through-core");
    const db = new Client({ connectionString: E2E_DATABASE_URL });
    await db.connect();
    try {
      for (const path of E2E_FILES) {
        const bytes = new Uint8Array(readFileSync(path));
        const type = path.endsWith(".pdf") ? "application/pdf" : "image/jpeg";
        const meta = uploadHeaders({ name: basename(path), experiment: E2E_EXPERIMENT, uploadedOn: localDay(new Date()), modifiedAt: null });
        // Start, PUT to the local store's stand-in for R2, then complete, as the upload page does.
        const accepted = await sendUpload(E2E_LAB, { bytes, meta, type }, async (args) => {
          await db.query("begin");
          await db.query("set local role authenticated");
          await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: E2E_USER })]);
          const res = await db.query(
            "select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from record_upload($1, $2, $3, $4, $5, $6::date, $7::timestamptz) r",
            [args.p_lab_id, args.p_sha256, args.p_size, args.p_name, args.p_experiment, args.p_uploaded_on, args.p_modified_at],
          );
          await db.query("commit");
          return { data: res.rows[0]?.rows, error: null };
        });
        process.stdout.write(`${basename(path)}: ${JSON.stringify(accepted)}\n`);
        expect(accepted.status).toBe(201);
      }
    } finally {
      await db.end();
    }
  });
});
