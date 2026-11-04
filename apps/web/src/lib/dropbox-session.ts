import "server-only";
import { z } from "zod";
import { dropboxEnv, tokenKeyEnv } from "@/env";
import { refreshAccessToken } from "./dropbox";
import type { LabId, SourceId } from "./ids";
import { createServiceSupabase, unwrap } from "./supabase/server";
import { decryptToken, fromPgBytea } from "./token-crypto";

const TokenRow = z.object({ token_ciphertext: z.string() });

// token_ciphertext has no column grant for signed-in users, so this read uses
// the service role. Callers must already have checked the user is the lab's admin.
export async function sourceAccessToken({ labId, sourceId }: { labId: LabId; sourceId: SourceId }): Promise<string> {
  const row = TokenRow.parse(
    unwrap(
      await createServiceSupabase()
        .from("sources")
        .select("token_ciphertext")
        .eq("id", sourceId)
        .eq("lab_id", labId)
        .single(),
    ),
  );
  const refreshToken = decryptToken({ key: tokenKeyEnv().TOKEN_ENCRYPTION_KEY, blob: fromPgBytea(row.token_ciphertext) });
  const env = dropboxEnv();
  return refreshAccessToken({ appKey: env.DROPBOX_APP_KEY, appSecret: env.DROPBOX_APP_SECRET, refreshToken });
}
