import { describe, expect, it } from "vitest";
import { assertProductionEnv, isProductionDeploy, productionEnvProblems } from "@/env";

const KEY = Buffer.alloc(32, 7).toString("base64");

const READY = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  TOKEN_ENCRYPTION_KEY: KEY,
  DROPBOX_APP_KEY: "k",
  DROPBOX_APP_SECRET: "s",
  DROPBOX_REDIRECT_URI: "https://app.example.com/api/dropbox/callback",
  R2_ACCOUNT_ID: "a",
  R2_ACCESS_KEY_ID: "b",
  R2_SECRET_ACCESS_KEY: "c",
  R2_BUCKET: "binary-labs-previews",
  EMBED_URL: "https://lab--binary-embed.modal.run/embed",
  EMBED_API_KEY: "e",
  ANTHROPIC_API_KEY: "sk-ant",
} as const;

const names = (problems: string[]) => problems.map((p) => p.split(":")[0]);

describe("the production environment check", () => {
  it("passes a complete environment, with the store defaulting to R2", () => {
    expect(productionEnvProblems({ ...READY })).toEqual([]);
    expect(productionEnvProblems({ ...READY, PREVIEW_STORE: "r2" })).toEqual([]);
  });

  it("lists every missing variable at once, empty values included", () => {
    const problems = productionEnvProblems({ ...READY, EMBED_API_KEY: "", ANTHROPIC_API_KEY: undefined, R2_BUCKET: "  " });
    expect(problems).toEqual(["R2_BUCKET: missing", "EMBED_API_KEY: missing", "ANTHROPIC_API_KEY: missing"]);
    expect(productionEnvProblems({})).toHaveLength(Object.keys(READY).length);
  });

  it("names malformed values and why", () => {
    const problems = productionEnvProblems({
      ...READY,
      NEXT_PUBLIC_SUPABASE_URL: "http://abcdefgh.supabase.co",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64"),
      DROPBOX_REDIRECT_URI: "https://app.example.com/callback",
      PREVIEW_STORE: "local",
      EMBED_URL: "not a url",
    });
    expect(names(problems)).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "TOKEN_ENCRYPTION_KEY",
      "DROPBOX_REDIRECT_URI",
      "PREVIEW_STORE",
      "EMBED_URL",
    ]);
    expect(problems[0]).toBe("NEXT_PUBLIC_SUPABASE_URL: NEXT_PUBLIC_SUPABASE_URL must be an https:// URL in production");
    expect(problems[3]).toBe("PREVIEW_STORE: PREVIEW_STORE must be r2 in production");
  });

  it("runs only in a production deploy, so dev and tests keep working with fewer variables", () => {
    expect(isProductionDeploy({ NODE_ENV: "production" })).toBe(false);
    expect(isProductionDeploy({ VERCEL_ENV: "preview" })).toBe(false);
    expect(isProductionDeploy({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProductionDeploy({ BINARY_ENV: "production" })).toBe(true);
    expect(() => assertProductionEnv({ NODE_ENV: "production" })).not.toThrow();
    expect(() => assertProductionEnv({ VERCEL_ENV: "production", ...READY })).not.toThrow();
  });

  it("stops a production deploy with one message", () => {
    expect(() => assertProductionEnv({ VERCEL_ENV: "production", ...READY, EMBED_URL: undefined, DROPBOX_APP_SECRET: "" })).toThrow(
      "Binary's environment isn't ready for production:\n  - DROPBOX_APP_SECRET: missing\n  - EMBED_URL: missing",
    );
  });
});
