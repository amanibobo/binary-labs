import { NextResponse, type NextRequest } from "next/server";
import { askSetup, loadFileLabels, loadOpenSuggestions, loadSavedAnswer, memberAskReads, questionEmbedder, serviceAnswerWriter } from "@/lib/ask-db";
import { UNAVAILABLE_MESSAGE } from "@/lib/ask";
import { ModelUnavailable } from "@/lib/json-model";
import { loadExperiments, loadPeople, loadProtocolVersion } from "@/lib/lab-data";
import { logError } from "@/lib/log";
import { readJson, routeAccess } from "@/lib/route-auth";
import { suggestLabels, suggestProtocolEdit, type Drafted } from "@/lib/suggest";
import { SuggestRequest, type SuggestOutcome } from "@/lib/suggestions";

const NO_STORE = { "cache-control": "private, no-store" };

// Drafts a suggestion. It's saved as open and changes nothing until a member approves it.
export async function POST(request: NextRequest) {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab, user } = access.member;
  const body = SuggestRequest.safeParse(await readJson(request));
  if (!body.success) return NextResponse.json({ error: "Pick what to suggest a change to." }, { status: 400 });
  const setup = askSetup();
  if (setup.kind === "unavailable") {
    return NextResponse.json({ error: "Suggestions aren't set up here.", reason: "unavailable" }, { status: 503, headers: NO_STORE });
  }
  const deps = {
    labId: lab.id,
    userId: user.id,
    reads: memberAskReads(supabase, lab.id),
    writer: serviceAnswerWriter(),
    model: setup.model,
    embed: questionEmbedder(),
  };
  try {
    let drafted: Drafted;
    const req = body.data;
    switch (req.kind) {
      case "protocol_edit": {
        const [protocol, asked] = await Promise.all([
          loadProtocolVersion(supabase, req.protocolId, null),
          req.questionId === null ? Promise.resolve(null) : loadSavedAnswer(supabase, lab.id, req.questionId, user.id),
        ]);
        if (protocol === null) return NextResponse.json({ error: "This protocol isn't in your lab." }, { status: 404 });
        if (protocol.archived) return NextResponse.json({ error: "This protocol is archived." }, { status: 409 });
        drafted = await suggestProtocolEdit(deps, { protocol, questionId: asked?.id ?? null, question: asked?.question ?? null });
        break;
      }
      case "labels": {
        const asked = await loadSavedAnswer(supabase, lab.id, req.questionId, user.id);
        if (asked === null) return NextResponse.json({ error: "That question isn't in your lab." }, { status: 404 });
        const shas = asked.sources.flatMap((s) => (s.kind === "file" ? [s.sha256] : []));
        const [labels, experiments, people] = await Promise.all([
          loadFileLabels(supabase, lab.id, shas),
          loadExperiments(supabase, lab.id),
          loadPeople(supabase, lab.id),
        ]);
        drafted = await suggestLabels(deps, { asked, labels, lists: { experiments, people } });
        break;
      }
      default: {
        const _exhaustive: never = req;
        return _exhaustive;
      }
    }
    return NextResponse.json(drafted satisfies SuggestOutcome, { headers: NO_STORE });
  } catch (error) {
    if (!(error instanceof ModelUnavailable)) logError("suggestions.draft_failed", { labId: lab.id, error });
    return NextResponse.json({ error: UNAVAILABLE_MESSAGE }, { status: 502 });
  }
}

export async function GET() {
  const access = await routeAccess({ admin: false });
  if (access.kind === "denied") return access.response;
  const { supabase, lab } = access.member;
  try {
    return NextResponse.json(await loadOpenSuggestions(supabase, lab.id, null), { headers: NO_STORE });
  } catch (error) {
    logError("suggestions.list_failed", { labId: lab.id, error });
    return NextResponse.json({ error: "We couldn't load suggestions." }, { status: 500 });
  }
}
