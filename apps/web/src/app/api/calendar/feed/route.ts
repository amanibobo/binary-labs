import { z } from "zod";
import { entryError, readError } from "@/lib/calendar-store";
import type { FeedStatus } from "@/lib/calendar";
import { feedPath, newFeedToken } from "@/lib/calendar-feed";
import { requestOrigin } from "@/lib/origin";
import { ok } from "@/lib/protocol-routes";
import { routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";

const FeedRows = z.array(z.object({ created_at: z.string() }));

// GET: when the caller made their feed address in this lab, or null. The address isn't kept.
export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  try {
    // RLS shows each member only their own row.
    const rows = FeedRows.parse(unwrap(await supabase.from("calendar_feeds").select("created_at").eq("lab_id", lab.id)));
    return ok({ madeAt: rows[0]?.created_at ?? null } satisfies FeedStatus);
  } catch (error) {
    return readError(error, { event: "calendar.feed_status_failed", labId: lab.id });
  }
}

// POST: a new address, shown this once. The old one stops working.
export async function POST() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const { token, hash } = newFeedToken();
  const { data, error } = await supabase.rpc("calendar_feed_reset", { p_lab_id: lab.id, p_token_hash: hash });
  if (error !== null) return entryError(error, { event: "calendar.feed_reset_failed", labId: lab.id }, "We couldn't make a feed address. Try again.");
  return ok({ url: `${await requestOrigin()}${feedPath(token)}`, madeAt: z.string().parse(data) });
}
