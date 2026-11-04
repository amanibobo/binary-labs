import "server-only";
import { NextResponse } from "next/server";
import { loadViewer, type Member } from "./viewer";

export type RouteAccess = { kind: "allowed"; member: Member } | { kind: "denied"; response: NextResponse };

const deny = (status: number, error: string): RouteAccess => ({
  kind: "denied",
  response: NextResponse.json({ error }, { status }),
});

export async function routeAccess({ admin }: { admin: boolean }): Promise<RouteAccess> {
  const viewer = await loadViewer();
  switch (viewer.kind) {
    case "config_missing":
      return deny(503, `not configured: ${viewer.missing.join(", ")}`);
    case "signed_out":
      return deny(401, "sign in first");
    case "no_lab":
      return deny(403, "create a lab first");
    case "member":
      if (admin && viewer.lab.role !== "admin") return deny(403, "admins only");
      return { kind: "allowed", member: viewer };
    default: {
      const _exhaustive: never = viewer;
      return _exhaustive;
    }
  }
}
