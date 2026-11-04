import "server-only";
import { z } from "zod";
import { dropboxEnv, tokenKeyEnv } from "@/env";
import { refreshAccessToken, revokeRefreshToken } from "./dropbox";
import type { LabId, SourceId } from "./ids";
import { logError } from "./log";
import { createServiceSupabase, unwrap } from "./supabase/server";
import { decryptToken, fromPgBytea } from "./token-crypto";

const TokenRows = z.array(z.object({ token_ciphertext: z.string() }));

// token_ciphertext has no column grant for signed-in users, so these reads use
// the service role. Callers must already have checked the user is the lab's admin.
async function refreshTokens({ labId, sourceId }: { labId: LabId; sourceId?: SourceId }): Promise<string[]> {
  let query = createServiceSupabase()
    .from("sources")
    .select("token_ciphertext")
    .eq("lab_id", labId)
    .eq("kind", "dropbox")
    .not("token_ciphertext", "is", null);
  if (sourceId !== undefined) query = query.eq("id", sourceId);
  const key = tokenKeyEnv().TOKEN_ENCRYPTION_KEY;
  return TokenRows.parse(unwrap(await query)).map((row) => decryptToken({ key, blob: fromPgBytea(row.token_ciphertext) }));
}

export async function sourceAccessToken({ labId, sourceId }: { labId: LabId; sourceId: SourceId }): Promise<string> {
  const [refreshToken] = await refreshTokens({ labId, sourceId });
  if (refreshToken === undefined) throw new Error("Dropbox is disconnected");
  const env = dropboxEnv();
  return refreshAccessToken({ appKey: env.DROPBOX_APP_KEY, appSecret: env.DROPBOX_APP_SECRET, refreshToken });
}

export type HeldTokens = { labId: LabId; refreshTokens: string[] };

// Read before the database drops the tokens, revoked after it has.
export async function holdTokens({ labId, sourceId }: { labId: LabId; sourceId?: SourceId }): Promise<HeldTokens> {
  return { labId, refreshTokens: await refreshTokens({ labId, sourceId }) };
}

// Never throws: the tokens are already gone from the database, and a Dropbox outage
// mustn't undo a disconnect or a deletion. A token that fails here stays valid at
// Dropbox until the account owner removes the app, but we no longer hold it.
export async function revokeHeldTokens({ labId, refreshTokens: tokens }: HeldTokens): Promise<void> {
  if (tokens.length === 0) return;
  try {
    const env = dropboxEnv();
    const results = await Promise.allSettled(
      tokens.map((refreshToken) =>
        revokeRefreshToken({ appKey: env.DROPBOX_APP_KEY, appSecret: env.DROPBOX_APP_SECRET, refreshToken }),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") logError("dropbox.revoke_failed", { labId, error: result.reason });
    }
  } catch (error) {
    logError("dropbox.revoke_failed", { labId, error });
  }
}
