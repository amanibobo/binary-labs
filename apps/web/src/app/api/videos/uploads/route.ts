import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";
import { startVideoUpload } from "@/lib/video-upload";
import { StartVideoRequest } from "@/lib/videos";

const PageRows = z.array(z.object({ archived_at: z.string().nullable() }));

// Starts a video's multipart upload. The page is checked now, so nobody sends 500 MB to a
// page they can't add to; record_video checks it again at the end.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = StartVideoRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);

  const started = await startVideoUpload(lab.id, body.data, async (protocolId) => {
    const [page] = PageRows.parse(
      unwrap(await supabase.from("protocols").select("archived_at").eq("id", protocolId).eq("lab_id", lab.id).limit(1)),
    );
    if (page === undefined) return "missing";
    return page.archived_at === null ? "open" : "archived";
  });
  return "session" in started ? ok(started.session) : NextResponse.json({ error: started.error }, { status: started.status });
}
