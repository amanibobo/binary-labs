import type { NextRequest } from "next/server";
import { asInstrument } from "@/lib/instrument-routes";
import { heartbeat } from "@/lib/instrument-upload";

// The uploader checks in every minute; authorizing the token notes when it was last seen.
export async function POST(request: NextRequest) {
  return asInstrument(request, async (session) => heartbeat(session));
}
