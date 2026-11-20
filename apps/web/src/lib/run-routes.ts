import "server-only";
import { NextResponse } from "next/server";
import { RunId } from "./ids";
import { routeAccess } from "./route-auth";
import type { Member } from "./viewer";

// Every run record route starts the same way: a signed-in member, and a run id that parses.
// The database decides whether the run is their lab's.
export async function runAccess(params: Promise<{ id: string }>): Promise<{ kind: "denied"; response: NextResponse } | { kind: "allowed"; member: Member; id: RunId }> {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access;
  const id = RunId.safeParse((await params).id);
  if (!id.success) return { kind: "denied", response: NextResponse.json({ error: "That run doesn't exist." }, { status: 404 }) };
  return { kind: "allowed", member: access.member, id: id.data };
}

export const runNotFound = () => NextResponse.json({ error: "That run doesn't exist any more." }, { status: 404 });
