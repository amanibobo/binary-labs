import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_ENV_NAMES } from "@/env";

// .env.production.example is what docs/deploy.md has the user copy into Vercel. It has to name
// every variable the app reads in production and nothing it doesn't, or a deploy goes out
// with a gap the template never mentioned.

const APP = join(__dirname, "../../..");

function templateNames(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Read outside src/env.ts's schemas, and why each stays out of the template.
const NOT_IN_TEMPLATE = new Set([
  "NODE_ENV", // set by Next
  "NEXT_RUNTIME", // set by Next
  "VERCEL_ENV", // set by Vercel
  "BINARY_ENV", // turns the production check on off Vercel; VERCEL_ENV does it there
  "BINARY_LABS_FIXTURES", // dev fixture pages, which production builds leave out
  "PREVIEW_DIR", // the local store only
]);

describe("apps/web/.env.production.example", () => {
  const names = templateNames(join(APP, ".env.production.example"));

  it("lists each production variable once", () => {
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...PRODUCTION_ENV_NAMES].sort());
  });

  it("covers every variable the code reads", () => {
    const read = new Set<string>();
    for (const file of [...sourceFiles(join(APP, "src")), join(APP, "next.config.ts")]) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1] ?? "");
      if (file.endsWith("env.ts")) for (const m of text.matchAll(/^\s+([A-Z][A-Z0-9_]+): /gm)) read.add(m[1] ?? "");
    }
    const unlisted = [...read].filter((name) => !names.includes(name) && !NOT_IN_TEMPLATE.has(name));
    expect(unlisted).toEqual([]);
  });
});
