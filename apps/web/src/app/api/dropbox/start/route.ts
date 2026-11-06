import { NextResponse, type NextRequest } from "next/server";
import { dropboxEnv } from "@/env";
import { authorizeUrl, createOAuthState, createPkce } from "@/lib/dropbox";
import { OAUTH_COOKIE, oauthCookieOptions } from "@/lib/dropbox-oauth";
import { loadSourceState } from "@/lib/lab-data";
import { routeAccess } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const access = await routeAccess({ admin: true });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;

  const existing = await loadSourceState(supabase, lab.id);
  if (existing.kind !== "not_connected" && existing.kind !== "disconnected") return NextResponse.redirect(new URL("/settings/dropbox", request.url));

  const env = dropboxEnv();
  const state = createOAuthState();
  const { verifier, challenge } = createPkce();
  const response = NextResponse.redirect(
    authorizeUrl({ appKey: env.DROPBOX_APP_KEY, redirectUri: env.DROPBOX_REDIRECT_URI, state, challenge }),
  );
  response.cookies.set(OAUTH_COOKIE, JSON.stringify({ state, verifier, labId: lab.id }), oauthCookieOptions());
  return response;
}
