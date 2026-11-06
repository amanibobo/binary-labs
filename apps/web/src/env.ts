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
  // The worker's PREVIEW_DIR, which the worker resolves from workers/; unset means the same default.
  z.object({ PREVIEW_STORE: z.literal("local"), PREVIEW_DIR: nonEmpty.optional() }),
]);

const EmbedEnv = z.object({ EMBED_URL: z.url(), EMBED_API_KEY: nonEmpty });

type EnvSource = Readonly<Record<string, string | undefined>>;

// `KEY=` lines in .env files arrive as empty strings; treat them as unset.
function definedEnv(source: EnvSource): Record<string, string> {
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

// A production deploy checks every group up front instead (instrumentation.ts at startup,
// next.config.ts at build), so a missing variable stops the deploy with one list rather than
// failing a request later. Vercel sets VERCEL_ENV; anywhere else, BINARY_ENV=production.
export function isProductionDeploy(source: EnvSource = process.env): boolean {
  return source.BINARY_ENV === "production" || source.VERCEL_ENV === "production";
}

const https = (name: string) =>
  z.url().refine((u) => URL.canParse(u) && new URL(u).protocol === "https:", `${name} must be an https:// URL in production`);

// What dev can do without: an embedding service (search runs keyword-only), labels and
// answers from the model, the R2 store (a local folder doesn't exist on a serverless host).
const ProductionEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: https("NEXT_PUBLIC_SUPABASE_URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  TOKEN_ENCRYPTION_KEY: TokenKeyEnv.shape.TOKEN_ENCRYPTION_KEY,
  DROPBOX_APP_KEY: nonEmpty,
  DROPBOX_APP_SECRET: nonEmpty,
  DROPBOX_REDIRECT_URI: https("DROPBOX_REDIRECT_URI").refine(
    (u) => URL.canParse(u) && new URL(u).pathname === "/api/dropbox/callback",
    "DROPBOX_REDIRECT_URI must end in /api/dropbox/callback",
  ),
  PREVIEW_STORE: z.literal("r2", { error: "PREVIEW_STORE must be r2 in production" }).default("r2"),
  R2_ACCOUNT_ID: nonEmpty,
  R2_ACCESS_KEY_ID: nonEmpty,
  R2_SECRET_ACCESS_KEY: nonEmpty,
  R2_BUCKET: nonEmpty,
  EMBED_URL: https("EMBED_URL"),
  EMBED_API_KEY: nonEmpty,
  ANTHROPIC_API_KEY: nonEmpty,
});

export const PRODUCTION_ENV_NAMES = Object.keys(ProductionEnv.shape);

// One line per bad variable; empty when a production deploy has what it needs.
export function productionEnvProblems(source: EnvSource): string[] {
  const defined = definedEnv(source);
  const parsed = ProductionEnv.safeParse(defined);
  if (parsed.success) return [];
  const byName = new Map<string, string>();
  for (const issue of parsed.error.issues) {
    const name = String(issue.path[0] ?? "env");
    if (!byName.has(name)) byName.set(name, name in defined ? issue.message : "missing");
  }
  return [...byName].map(([name, why]) => `${name}: ${why}`);
}

export function assertProductionEnv(source: EnvSource = process.env): void {
  if (!isProductionDeploy(source)) return;
  const problems = productionEnvProblems(source);
  if (problems.length > 0) {
    throw new Error(`Binary's environment isn't ready for production:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

export type EmbedConfig ={ kind: "configured"; url: string; apiKey: string } | { kind: "unconfigured" };

// Embedding is optional: without it search runs keyword-only and says so.
export function embedConfig(): EmbedConfig {
  const parsed = EmbedEnv.safeParse(definedEnv(process.env));
  return parsed.success
    ? { kind: "configured", url: parsed.data.EMBED_URL, apiKey: parsed.data.EMBED_API_KEY }
    : { kind: "unconfigured" };
}
