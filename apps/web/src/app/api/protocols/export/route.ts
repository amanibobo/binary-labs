import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { exportFileName, ProtocolExportRows, protocolsMarkdown } from "@/lib/lab-deletion";
import { logError } from "@/lib/log";
import { routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";

// Every current protocol and tutorial as one Markdown file, offered before a lab is deleted.
export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;

  try {
    const pages = ProtocolExportRows.parse(unwrap(await supabase.rpc("protocol_export", { p_lab_id: lab.id })));
    await audit(supabase, { labId: lab.id, actor: user.id, action: "protocol.export", target: null });
    return new NextResponse(protocolsMarkdown({ labName: lab.name, exportedAt: new Date(), pages }), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFileName(lab.name)}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    logError("protocols.export_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "couldn't export protocols" }, { status: 500 });
  }
}
