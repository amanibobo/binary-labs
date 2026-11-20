import { NextResponse, type NextRequest } from "next/server";
import { feedIcs, FeedJson, feedTokenHash, tokenFromPath } from "@/lib/calendar-feed";
import { logError } from "@/lib/log";
import { requestOrigin } from "@/lib/origin";
import { createServiceSupabase } from "@/lib/supabase/server";

// GET /api/calendar/feed/<token>.ics: the lab's plans for a calendar app to subscribe to. No
// session: the token is the only credential, and proxy.ts leaves this path alone. A token
// that was replaced, or whose member left the lab, answers 404 like one that never existed.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/calendar/feed/[token]">) {
  const token = tokenFromPath((await ctx.params).token);
  const gone = new NextResponse("This calendar address no longer works. Make a new one on Binary's calendar.", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
  if (token === null) return gone;
  const { data, error } = await createServiceSupabase().rpc("calendar_feed", { p_token_hash: feedTokenHash(token) });
  if (error !== null) {
    logError("calendar.feed_failed", { error });
    return new NextResponse("We couldn't read the calendar. Try again later.", { status: 500, headers: { "cache-control": "no-store" } });
  }
  const feed = FeedJson.parse(data);
  if (feed === null) return gone;
  const body = feedIcs({ lab: feed.lab, entries: feed.entries, origin: await requestOrigin(), now: new Date() });
  return new NextResponse(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="binary.ics"',
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
}
