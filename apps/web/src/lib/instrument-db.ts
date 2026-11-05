import "server-only";
import { createServiceSupabase } from "./supabase/server";

// The uploader's side of the database: three functions only the service role may call
// (migration 0013). Each takes the token's hash, so the database, not this server, decides
// which lab and source a token may write to. Routes reach it through instrumentDb() so the
// end-to-end run can swap in plain Postgres.

export type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

export type InstrumentDb = {
  pair(args: { p_code_hash: string; p_token_hash: string; p_client: string }): Promise<RpcResult>;
  session(args: { p_token_hash: string }): Promise<RpcResult>;
  record(args: {
    p_token_hash: string;
    p_path: string;
    p_sha256: string;
    p_size: number;
    p_modified_at: string | null;
  }): Promise<RpcResult>;
};

export function instrumentDb(): InstrumentDb {
  const supabase = createServiceSupabase();
  return {
    pair: async (args) => await supabase.rpc("pair_instrument", args),
    session: async (args) => await supabase.rpc("instrument_session", args),
    record: async (args) => await supabase.rpc("record_instrument_file", args),
  };
}
