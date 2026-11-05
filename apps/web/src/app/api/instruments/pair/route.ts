import type { NextRequest } from "next/server";
import { instrumentDb } from "@/lib/instrument-db";
import { badBody, jsonBody, reply } from "@/lib/instrument-routes";
import { clientKey, pairInstrument } from "@/lib/instrument-upload";
import { PairRequest } from "@/lib/instruments";

// The uploader trades a one-time code for its device token. No session: the code is the
// credential, and tries are limited per caller in the database.
export async function POST(request: NextRequest) {
  const body = PairRequest.safeParse(await jsonBody(request));
  if (!body.success) return reply(badBody(body.error));
  return reply(await pairInstrument(body.data.code, clientKey(request.headers), instrumentDb()));
}
