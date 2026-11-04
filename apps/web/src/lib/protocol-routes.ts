import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type { LabId } from "./ids";
import { logError } from "./log";
import { protocolFailure, type SaveOutcome } from "./protocols";

const NO_STORE = { "cache-control": "private, no-store" };

export function ok(body: unknown): NextResponse {
  return NextResponse.json(body, { headers: NO_STORE });
}

export function badRequest(error: z.ZodError): NextResponse {
  return NextResponse.json({ error: error.issues[0]?.message ?? "Check the page and try again." }, { status: 400 });
}

// A database error from a protocol function, as the browser should see it.
export function protocolError(error: { code?: string; message: string }, ctx: { event: string; labId: LabId }): NextResponse {
  const failure = protocolFailure(error);
  switch (failure.kind) {
    case "stale":
      return NextResponse.json(
        { kind: "stale", error: "Someone saved a newer version." } satisfies SaveOutcome & { error: string },
        { status: 409, headers: NO_STORE },
      );
    case "error":
      if (failure.status === 500) logError(ctx.event, { labId: ctx.labId, error });
      return NextResponse.json({ error: failure.message }, { status: failure.status, headers: NO_STORE });
    default: {
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
}

export function shapeError(error: unknown, ctx: { event: string; labId: LabId }): NextResponse {
  logError(ctx.event, { labId: ctx.labId, error });
  return NextResponse.json({ error: "We couldn't save that. Try again." }, { status: 500 });
}
