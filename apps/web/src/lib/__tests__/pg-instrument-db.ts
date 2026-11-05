import type { Client } from "pg";
import { z } from "zod";
import type { InstrumentDb, RpcResult } from "../instrument-db";

// The uploader's database functions on plain Postgres, called as the service role the way
// supabase-js calls them, with rows serialized by to_jsonb as PostgREST does. For db tests and
// the end-to-end run, where there's no Supabase.
export function pgInstrumentDb(db: Client): InstrumentDb {
  async function call(sql: string, params: unknown[]): Promise<RpcResult> {
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      const res = await db.query(`select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from ${sql} r`, params);
      await db.query("commit");
      return { data: z.object({ rows: z.unknown() }).parse(res.rows[0]).rows, error: null };
    } catch (err) {
      await db.query("rollback");
      return { data: null, error: z.object({ code: z.string().optional(), message: z.string() }).parse(err) };
    }
  }
  return {
    pair: (a) => call("pair_instrument($1, $2, $3)", [a.p_code_hash, a.p_token_hash, a.p_client]),
    session: (a) => call("instrument_session($1)", [a.p_token_hash]),
    record: (a) =>
      call("record_instrument_file($1, $2, $3, $4, $5::timestamptz)", [a.p_token_hash, a.p_path, a.p_sha256, a.p_size, a.p_modified_at]),
  };
}
