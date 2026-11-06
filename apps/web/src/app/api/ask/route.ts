import { NextResponse, type NextRequest } from "next/server";
import { AskRequest, type AskEvent } from "@/lib/answers";
import { askLab, UNAVAILABLE_MESSAGE } from "@/lib/ask";
import { askSetup, loadRecentQuestions, memberAskReads, questionEmbedder, serviceAnswerWriter } from "@/lib/ask-db";
import { logError } from "@/lib/log";
import { readJson, routeAccess } from "@/lib/route-auth";

// A question's answer comes back as it's written: one JSON event per line (lib/answers.ts).
export const maxDuration = 60;

const NO_STORE = { "cache-control": "private, no-store" };

export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;

  const body = AskRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "Ask a question of at least a few words." }, { status: 400 });
  const setup = askSetup();
  if (setup.kind === "unavailable") {
    return NextResponse.json({ error: "Asking the lab isn't set up here.", reason: "unavailable" }, { status: 503, headers: NO_STORE });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AskEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        await askLab(
          {
            labId: lab.id,
            userId: user.id,
            reads: memberAskReads(supabase, lab.id),
            writer: serviceAnswerWriter(),
            model: setup.model,
            embed: questionEmbedder(),
          },
          body.data.question,
          emit,
          request.signal,
        );
      } catch (error) {
        logError("ask.failed", { labId: lab.id, error });
        emit({ type: "failed", message: UNAVAILABLE_MESSAGE });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...NO_STORE, "content-type": "application/x-ndjson; charset=utf-8" } });
}

export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  try {
    return NextResponse.json(await loadRecentQuestions(supabase, lab.id), { headers: NO_STORE });
  } catch (error) {
    logError("ask.recent_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "We couldn't load recent questions." }, { status: 500 });
  }
}
