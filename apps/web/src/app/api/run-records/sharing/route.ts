import { NextResponse, type NextRequest } from "next/server";
import { SetLabShareRequest, SHARING_AGREEMENT } from "@/components/runs/api/sharing";
import { badRequest, ok } from "@/lib/protocol-routes";
import { readJson, routeAccess } from "@/lib/route-auth";
import { loadLabSharing, setLabShare, sharingError } from "@/lib/run-sharing-store";

// GET is the lab's side of sharing. POST is an admin agreeing to the sharing agreement for
// the lab, or taking the agreement back. The database checks the admin; this checks they
// agreed to the wording as it reads now.
export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  return ok(await loadLabSharing(supabase, lab.id));
}

export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = SetLabShareRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest(body.error);
  if (body.data.on && body.data.agreement !== SHARING_AGREEMENT.version) {
    return NextResponse.json({ error: "The agreement's wording has changed. Reload the page and read it again." }, { status: 409 });
  }
  const written = await setLabShare(supabase, lab.id, body.data.on, body.data.agreement);
  if (written.kind === "error") return sharingError(written.error, "lab", { event: "lab.share_failed", labId: lab.id });
  return ok(written.value);
}
