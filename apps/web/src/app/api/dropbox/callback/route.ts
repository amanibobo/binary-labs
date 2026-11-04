import { NextResponse, type NextRequest } from "next/server";
import { dropboxEnv, tokenKeyEnv } from "@/env";
import { audit } from "@/lib/audit";
import { accountLabel, exchangeCode } from "@/lib/dropbox";
import { OAUTH_COOKIE, oauthCookieOptions, readPendingOAuth, stateMatches } from "@/lib/dropbox-oauth";
import { loadSourceState } from "@/lib/lab-data";
import { logError } from "@/lib/log";
import { routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";
import { encryptToken, toPgBytea } from "@/lib/token-crypto";

function finish(request: NextRequest, path: string) {
  const response = NextResponse.redirect(new URL(path, request.url));
  response.cookies.set(OAUTH_COOKIE, "", { ...oauthCookieOptions(), maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: true });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;

  const params = request.nextUrl.searchParams;
  if (params.get("error") !== null) return finish(request, "/lab?dropbox=denied");

  const pending = readPendingOAuth(request.cookies.get(OAUTH_COOKIE)?.value);
  const code = params.get("code");
  const state = params.get("state");
  if (pending === null || code === null || state === null || !stateMatches(pending.state, state) || pending.labId !== lab.id) {
    return finish(request, "/lab?dropbox=expired");
  }

  try {
    if ((await loadSourceState(supabase, lab.id)).kind !== "not_connected") return finish(request, "/lab");
    const env = dropboxEnv();
    const tokens = await exchangeCode({
      appKey: env.DROPBOX_APP_KEY,
      appSecret: env.DROPBOX_APP_SECRET,
      redirectUri: env.DROPBOX_REDIRECT_URI,
      code,
      verifier: pending.verifier,
    });
    const label = await accountLabel(tokens.accessToken);
    const ciphertext = encryptToken({ key: tokenKeyEnv().TOKEN_ENCRYPTION_KEY, plaintext: tokens.refreshToken });
    unwrap(
      await supabase.from("sources").insert({
        lab_id: lab.id,
        kind: "dropbox",
        account_label: label,
        token_ciphertext: toPgBytea(ciphertext),
      }),
    );
    await audit(supabase, { labId: lab.id, actor: user.id, action: "source.connect", target: label });
  } catch (error) {
    logError("dropbox.connect_failed", { labId: lab.id, error });
    return finish(request, "/lab?dropbox=failed");
  }
  return finish(request, "/lab/folder");
}
