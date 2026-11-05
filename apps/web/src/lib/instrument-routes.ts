import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { instrumentDb, type InstrumentDb } from "./instrument-db";
import { authorize, UNPAIRED, type Answer, type InstrumentSession } from "./instrument-upload";
import { FileClaim, INSTRUMENT_MAX_BYTES } from "./instruments";
import { partCount, UploadedPart } from "./parts";

// What the uploader's routes share. None of them reads cookies: proxy.ts leaves
// /api/instruments/ alone, and the only credential is the device token, checked before the
// body is read so a caller without one learns nothing else.

export function reply(answer: Answer): NextResponse {
  const headers = { "cache-control": "no-store", ...answer.headers };
  return answer.body === null
    ? new NextResponse(null, { status: answer.status, headers })
    : NextResponse.json(answer.body, { status: answer.status, headers });
}

export function badBody(error: z.ZodError): Answer {
  return { status: 400, body: { error: error.issues[0]?.message ?? "That request isn't one the uploader sends." } };
}

export const INVALID_UPLOAD: Answer = { status: 400, body: { error: "invalid upload id" } };

// JSON bodies only, as the session routes take them.
export async function jsonBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return undefined;
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function asInstrument(
  request: Request,
  handle: (session: InstrumentSession, db: InstrumentDb) => Promise<Answer>,
): Promise<NextResponse> {
  const db = instrumentDb();
  const session = await authorize(request.headers, db);
  return reply(session === null ? UNPAIRED : await handle(session, db));
}

export const StagedUploadId = z.uuid();
export const PartNumber = z.coerce.number().int().min(1).max(partCount(INSTRUMENT_MAX_BYTES));
export const StoreId = z.string().min(1).max(1024);

export const PartTargetRequest = z.object({ storeId: StoreId, size: z.number().int().positive().max(INSTRUMENT_MAX_BYTES) });

export const CompleteRequest = FileClaim.extend({
  storeId: StoreId,
  parts: z.array(UploadedPart).min(1).max(partCount(INSTRUMENT_MAX_BYTES)),
});
