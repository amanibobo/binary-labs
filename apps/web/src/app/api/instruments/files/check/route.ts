import type { NextRequest } from "next/server";
import { asInstrument, badBody, jsonBody } from "@/lib/instrument-routes";
import { checkFile } from "@/lib/instrument-upload";
import { FileClaim } from "@/lib/instruments";

// "Do you already have this file?" Answers { have } and records the path when the lab does.
export async function POST(request: NextRequest) {
  return asInstrument(request, async (session, db) => {
    const claim = FileClaim.safeParse(await jsonBody(request));
    return claim.success ? checkFile(session, claim.data, db) : badBody(claim.error);
  });
}
