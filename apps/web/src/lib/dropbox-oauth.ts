import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { LabId } from "./ids";

export const OAUTH_COOKIE = "dropbox_oauth";

export function oauthCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/dropbox",
    maxAge: 600,
  };
}

const PendingOAuth = z.object({ state: z.string().min(1), verifier: z.string().min(43), labId: LabId });
export type PendingOAuth = z.infer<typeof PendingOAuth>;

export function readPendingOAuth(cookie: string | undefined): PendingOAuth | null {
  if (cookie === undefined) return null;
  try {
    const parsed = PendingOAuth.safeParse(JSON.parse(cookie));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function stateMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
