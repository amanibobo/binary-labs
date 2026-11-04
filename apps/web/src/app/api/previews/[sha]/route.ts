import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auditQuietly } from "@/lib/audit";
import { Sha256 } from "@/lib/ids";
import { deliverPreview } from "@/lib/previews";
import { routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";

const PreviewRow = z.object({ storage_key: z.string().min(1) });

export async function GET(request: NextRequest, ctx: RouteContext<"/api/previews/[sha]">) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;

  const sha = Sha256.safeParse((await ctx.params).sha);
  if (!sha.success) return NextResponse.json({ error: "invalid sha256" }, { status: 400 });

  // Read with the user's session: RLS decides whether this lab may see the preview.
  const rows = z.array(PreviewRow).parse(
    unwrap(await supabase.from("previews").select("storage_key").eq("lab_id", lab.id).eq("sha256", sha.data).limit(1)),
  );
  const row = rows[0];
  if (row === undefined) return NextResponse.json({ error: "no preview" }, { status: 404 });

  // Thumbnails in a result list aren't views; opening a result asks with ?view=1.
  if (request.nextUrl.searchParams.get("view") === "1") {
    after(() => auditQuietly(supabase, { labId: lab.id, actor: user.id, action: "preview.view", target: sha.data }));
  }

  const delivery = await deliverPreview(row.storage_key);
  switch (delivery.kind) {
    case "redirect":
      return NextResponse.redirect(delivery.url, { status: 302, headers: { "cache-control": "private, max-age=50" } });
    case "bytes":
      return new NextResponse(new Uint8Array(delivery.body), {
        headers: { "content-type": delivery.contentType, "cache-control": "private, max-age=300" },
      });
    case "missing":
      return NextResponse.json({ error: "preview file missing" }, { status: 404 });
    default: {
      const _exhaustive: never = delivery;
      return _exhaustive;
    }
  }
}
