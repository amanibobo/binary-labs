import { z } from "zod";

// Each group parses on first use, so `next build` and pages that don't need a
// group run without its variables. A missing group surfaces as ConfigError,
// which pages render as a plain "not configured" screen.

export class ConfigError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`Missing or invalid environment variables: ${missing.join(", ")}`);
    this.name = "ConfigError";
    this.missing = missing;
  }
}

const nonEmpty = z.string().trim().min(1);

const SupabaseEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
});

const ServiceRoleEnv = z.object({ SUPABASE_SERVICE_ROLE_KEY: nonEmpty });

const TokenKeyEnv = z.object({
  TOKEN_ENCRYPTION_KEY: z
    .base64()
    .transform((b64) => Buffer.from(b64, "base64"))
    .refine((key) => key.length === 32, "must decode to 32 bytes"),
});

const DropboxEnv = z.object({
  DROPBOX_APP_KEY: nonEmpty,
  DROPBOX_APP_SECRET: nonEmpty,
  DROPBOX_REDIRECT_URI: z.url(),
});

const PreviewEnv = z.discriminatedUnion("PREVIEW_STORE", [
  z.object({
    PREVIEW_STORE: z.literal("r2"),
    R2_ACCOUNT_ID: nonEmpty,
    R2_ACCESS_KEY_ID: nonEmpty,
    R2_SECRET_ACCESS_KEY: nonEmpty,
    R2_BUCKET: nonEmpty,
  }),
  z.object({ PREVIEW_STORE: z.literal("local") }),
]);

const EmbedEnv = z.object({ EMBED_URL: z.url(), EMBED_API_KEY: nonEmpty });

// `KEY=` lines in .env files arrive as empty strings; treat them as unset.
function definedEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => (entry[1] ?? "").trim() !== ""),
  );
}

function lazyGroup<T>(schema: z.ZodType<T>): () => T {
  let cached: T | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const parsed = schema.safeParse(definedEnv(process.env));
    if (!parsed.success) {
      throw new ConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "env")))]);
    }
    cached = parsed.data;
    return cached;
  };
}

export const supabaseEnv = lazyGroup(SupabaseEnv);
export const serviceRoleEnv = lazyGroup(ServiceRoleEnv);
export const tokenKeyEnv = lazyGroup(TokenKeyEnv);
export const dropboxEnv = lazyGroup(DropboxEnv);
export const previewEnv = lazyGroup(
  z.preprocess(
    (raw) => (typeof raw === "object" && raw !== null ? { PREVIEW_STORE: "r2", ...raw } : raw),
    PreviewEnv,
  ),
);

export type EmbedConfig = { kind: "configured"; url: string; apiKey: string } | { kind: "unconfigured" };

// Embedding is optional: without it search runs keyword-only and says so.
export function embedConfig(): EmbedConfig {
  const parsed = EmbedEnv.safeParse(definedEnv(process.env));
  return parsed.success
    ? { kind: "configured", url: parsed.data.EMBED_URL, apiKey: parsed.data.EMBED_API_KEY }
    : { kind: "unconfigured" };
}
