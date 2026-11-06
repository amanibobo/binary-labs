import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FileCheckRows, FlagMarkRows, FlagRows, queueOrder } from "../flags";
import { LabId } from "../ids";

// Driven by scripts/e2e-checks.sh, after the real worker checked the arriving files. Reads the
// flags the way the Flags page and a file's opened row do, as a member. Skipped in the unit run.
const env = z.object({ E2E_DATABASE_URL: z.string(), E2E_USER: z.string().min(1), E2E_LAB: z.string().min(1) }).safeParse(process.env);

describe.runIf(env.success)("flags the worker raised, through the web's parsers", () => {
  it("reads every flag with its source, a file's checks and the row marks", async () => {
    if (!env.success) return;
    const lab = LabId.parse(env.data.E2E_LAB);
    const db = new Client({ connectionString: env.data.E2E_DATABASE_URL });
    await db.connect();
    const asMember = async (sql: string, params: unknown[]) => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: env.data.E2E_USER })]);
        const res = await db.query(`with r as (${sql}) select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from r`, params);
        await db.query("commit");
        return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    };
    try {
      const flags = FlagRows.parse(await asMember("select * from lab_flags($1) where cleared_at is null", [lab]));
      const { waiting, answered } = queueOrder(flags);
      expect(waiting.map((f) => [f.source.file?.location.originalName, f.checkName, f.observed])).toEqual([
        ["plate8_A595_endpoint.csv", "Blanks", 0.225],
      ]);
      expect(answered.map((f) => [f.source.file?.location.originalName, f.answer?.review])).toEqual([["Bradford_2026-11-04.xlsx", "useful"]]);
      for (const flag of flags) {
        expect(flag.protocolTitle).toBe("Bradford assay");
        expect(flag.protocolVersion).toBe(2);
        expect(flag.source.rows.length).toBeGreaterThan(0);
      }
      const plate = waiting[0];
      expect(plate?.control?.rows).toEqual([[0, 2]]);
      const checks = FileCheckRows.parse(await asMember("select * from file_checks($1, $2)", [lab, plate?.source.sha256]));
      expect(checks.map((c) => [c.checkName, c.outcome.kind])).toEqual([
        ["Standard curve fit", "couldnt"],
        ["Blanks", "flagged"],
      ]);
      const marks = FlagMarkRows.parse(await asMember("select * from file_flag_marks($1, $2)", [lab, flags.map((f) => f.source.sha256)]));
      expect(marks).toHaveLength(2);
    } finally {
      await db.end();
    }
  });
});
