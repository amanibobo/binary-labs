import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Verdict } from "@/lib/answers";
import { loadSavedAnswer } from "@/lib/ask-db";
import { QuestionId } from "@/lib/ids";
import { logError } from "@/lib/log";
import { readJson, routeAccess } from "@/lib/route-auth";
import { unwrap } from "@/lib/supabase/server";

const NO_STORE = { "cache-control": "private, no-store" };

// A saved question with its answer, to open again from the lab's recent questions.
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/ask/[id]">) {
  const id = QuestionId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "no such question" }, { status: 404 });
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;
  try {
    const saved = await loadSavedAnswer(supabase, lab.id, id.data, user.id);
    if (saved === null) return NextResponse.json({ error: "no such question" }, { status: 404 });
    return NextResponse.json(saved, { headers: NO_STORE });
  } catch (error) {
    logError("ask.load_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "We couldn't open that answer." }, { status: 500 });
  }
}

// "Helpful" or "Not helpful", one per member per answer; sending again changes it.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/ask/[id]">) {
  const id = QuestionId.safeParse((await ctx.params).id);
  if (!id.success) return NextResponse.json({ error: "no such question" }, { status: 404 });
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  const body = z.object({ verdict: Verdict }).safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "Say whether it helped." }, { status: 400 });
  try {
    unwrap(await supabase.rpc("give_answer_feedback", { p_question_id: id.data, p_verdict: body.data.verdict }));
    return NextResponse.json({ verdict: body.data.verdict }, { headers: NO_STORE });
  } catch (error) {
    logError("ask.feedback_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "We couldn't save that. Try again." }, { status: 500 });
  }
}
