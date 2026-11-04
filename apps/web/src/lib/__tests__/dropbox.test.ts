import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DROPBOX_ENDPOINTS, DROPBOX_SCOPES, DropboxError, authorizeUrl, createPkce, revokeRefreshToken } from "../dropbox";
import { openInDropboxUrl } from "../format";

const srcRoot = join(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("dropbox surface", () => {
  it("asks for read scopes only", () => {
    expect(DROPBOX_SCOPES.split(" ").sort()).toEqual(["account_info.read", "files.content.read", "files.metadata.read"]);
  });

  it("names no Dropbox endpoint outside the read-only allowlist anywhere in src", () => {
    const allowed = new Set<string>(Object.values(DROPBOX_ENDPOINTS));
    const found = sourceFiles(srcRoot).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/https:\/\/(?:api|content|notify)\.dropboxapi\.com\/[\w/.-]*/g)].map(
        (m) => `${m[0]} in ${file}`,
      ),
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((f) => !allowed.has(f.split(" in ")[0] ?? ""))).toEqual([]);
    expect(sourceFiles(srcRoot).filter((f) => /files\/(upload|delete|move|copy|create_folder)/.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("builds an offline PKCE authorize URL", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const url = new URL(authorizeUrl({ appKey: "key", redirectUri: "http://localhost:3100/api/dropbox/callback", state: "s1", challenge }));
    expect(url.origin + url.pathname).toBe(DROPBOX_ENDPOINTS.authorize);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      token_access_type: "offline",
      scope: DROPBOX_SCOPES,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state: "s1",
      response_type: "code",
    });
  });

  it("links to the file's place in Dropbox", () => {
    expect(openInDropboxUrl("/Lab/Gels 2026/IMG #1.jpg")).toBe("https://www.dropbox.com/home/Lab/Gels%202026/IMG%20%231.jpg");
  });
});

describe("revoking a token", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubDropbox(revokeStatus: number) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === DROPBOX_ENDPOINTS.token) return Response.json({ access_token: "short-lived" });
      return new Response(revokeStatus === 200 ? "null" : "error", { status: revokeStatus });
    });
    return calls;
  }

  it("mints an access token from the refresh token and revokes it, which ends the refresh token too", async () => {
    const calls = stubDropbox(200);
    await revokeRefreshToken({ appKey: "key", appSecret: "secret", refreshToken: "refresh-1" });
    expect(calls.map((c) => c.url)).toEqual([DROPBOX_ENDPOINTS.token, DROPBOX_ENDPOINTS.revokeToken]);
    expect(String(calls[0]?.init?.body)).toContain("refresh_token=refresh-1");
    expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe("Bearer short-lived");
  });

  it("throws when Dropbox refuses, for the caller to log", async () => {
    stubDropbox(401);
    await expect(revokeRefreshToken({ appKey: "key", appSecret: "secret", refreshToken: "refresh-1" })).rejects.toBeInstanceOf(DropboxError);
  });
});
