import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// Read-only by design (prd.md, Security): these scopes and endpoints are the
// whole Dropbox surface. A test fails if any other endpoint appears in src/.
export const DROPBOX_SCOPES = "files.metadata.read files.content.read account_info.read";

export const DROPBOX_ENDPOINTS = {
  authorize: "https://www.dropbox.com/oauth2/authorize",
  token: "https://api.dropboxapi.com/oauth2/token",
  currentAccount: "https://api.dropboxapi.com/2/users/get_current_account",
  listFolder: "https://api.dropboxapi.com/2/files/list_folder",
  listFolderContinue: "https://api.dropboxapi.com/2/files/list_folder/continue",
  getMetadata: "https://api.dropboxapi.com/2/files/get_metadata",
  // A four-hour link to one file's bytes, for playing a lab's Dropbox video on its protocol page.
  getTemporaryLink: "https://api.dropboxapi.com/2/files/get_temporary_link",
  // Ends our access on disconnect or lab deletion; it changes nothing in the lab's Dropbox.
  revokeToken: "https://api.dropboxapi.com/2/auth/token/revoke",
} as const;

type ApiEndpoint = (typeof DROPBOX_ENDPOINTS)[
  "currentAccount" | "listFolder" | "listFolderContinue" | "getMetadata" | "getTemporaryLink"
];

export class DropboxError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DropboxError";
    this.status = status;
  }
}

const base64url = (buf: Buffer) => buf.toString("base64url");

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export function createOAuthState(): string {
  return base64url(randomBytes(24));
}

export function authorizeUrl({
  appKey,
  redirectUri,
  state,
  challenge,
}: {
  appKey: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(DROPBOX_ENDPOINTS.authorize);
  url.search = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    redirect_uri: redirectUri,
    token_access_type: "offline",
    scope: DROPBOX_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  return url.toString();
}

type AppCredentials = { appKey: string; appSecret: string };

const CodeExchange = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) });
const Refreshed = z.object({ access_token: z.string().min(1) });

async function postToken(params: Record<string, string>): Promise<unknown> {
  const res = await fetch(DROPBOX_ENDPOINTS.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new DropboxError(`token request failed: ${await res.text()}`, res.status);
  return res.json();
}

export async function exchangeCode({
  appKey,
  appSecret,
  redirectUri,
  code,
  verifier,
}: AppCredentials & { redirectUri: string; code: string; verifier: string }) {
  const body = CodeExchange.parse(
    await postToken({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: appKey,
      client_secret: appSecret,
    }),
  );
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

export async function refreshAccessToken({ appKey, appSecret, refreshToken }: AppCredentials & { refreshToken: string }) {
  const body = Refreshed.parse(
    await postToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: appKey, client_secret: appSecret }),
  );
  return body.access_token;
}

// Revoking an access token also revokes the refresh token it came from, and every
// other access token minted from it.
export async function revokeRefreshToken(credentials: AppCredentials & { refreshToken: string }): Promise<void> {
  const accessToken = await refreshAccessToken(credentials);
  const res = await fetch(DROPBOX_ENDPOINTS.revokeToken, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new DropboxError(`token revoke failed: ${await res.text()}`, res.status);
}

async function rpc(endpoint: ApiEndpoint, accessToken: string, body: unknown): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    // get_current_account takes no arguments and rejects a JSON body.
    body: body === null ? "null" : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new DropboxError(`${endpoint} failed: ${await res.text()}`, res.status);
  return res.json();
}

const Account = z.object({ email: z.string(), name: z.object({ display_name: z.string() }) });

export async function accountLabel(accessToken: string): Promise<string> {
  const account = Account.parse(await rpc(DROPBOX_ENDPOINTS.currentAccount, accessToken, null));
  return account.email || account.name.display_name;
}

const Entry = z.discriminatedUnion(".tag", [
  z.object({ ".tag": z.literal("folder"), name: z.string(), path_display: z.string(), path_lower: z.string() }),
  z.object({ ".tag": z.literal("file"), name: z.string() }),
  z.object({ ".tag": z.literal("deleted"), name: z.string() }),
]);
const ListFolderPage = z.object({ entries: z.array(Entry), cursor: z.string(), has_more: z.boolean() });

export type DropboxFolder = { name: string; path: string };

const MAX_PAGES = 10;

// Dropbox calls the account root "", not "/".
export async function listFolders(accessToken: string, path: string): Promise<DropboxFolder[]> {
  const folders: DropboxFolder[] = [];
  let page = ListFolderPage.parse(
    await rpc(DROPBOX_ENDPOINTS.listFolder, accessToken, { path, recursive: false, include_deleted: false, limit: 2000 }),
  );
  for (let i = 0; ; i++) {
    for (const entry of page.entries) {
      if (entry[".tag"] === "folder") folders.push({ name: entry.name, path: entry.path_display });
    }
    if (!page.has_more || i + 1 >= MAX_PAGES) break;
    page = ListFolderPage.parse(await rpc(DROPBOX_ENDPOINTS.listFolderContinue, accessToken, { cursor: page.cursor }));
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

const Metadata = z.object({ ".tag": z.enum(["file", "folder", "deleted"]), path_display: z.string().optional() });

export async function folderPath(accessToken: string, path: string): Promise<string | null> {
  try {
    const meta = Metadata.parse(await rpc(DROPBOX_ENDPOINTS.getMetadata, accessToken, { path }));
    return meta[".tag"] === "folder" ? (meta.path_display ?? path) : null;
  } catch (err) {
    if (err instanceof DropboxError && err.status === 409) return null;
    throw err;
  }
}

const TemporaryLink = z.object({ link: z.url() });

// `path` may be a file id ("id:…"), which is what the index keeps.
export async function temporaryLink(accessToken: string, path: string): Promise<string> {
  return TemporaryLink.parse(await rpc(DROPBOX_ENDPOINTS.getTemporaryLink, accessToken, { path })).link;
}
