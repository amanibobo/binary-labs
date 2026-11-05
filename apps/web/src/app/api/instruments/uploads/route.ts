import type { NextRequest } from "next/server";
import { asInstrument, badBody, jsonBody } from "@/lib/instrument-routes";
import { startUpload } from "@/lib/instrument-upload";
import { FileClaim } from "@/lib/instruments";

// Starts sending one file in parts, staged under the token's own lab.
export async function POST(request: NextRequest) {
  return asInstrument(request, async (session) => {
    const claim = FileClaim.safeParse(await jsonBody(request));
    return claim.success ? startUpload(session, claim.data) : badBody(claim.error);
  });
}
