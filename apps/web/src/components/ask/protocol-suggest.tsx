"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import type { ProtocolId } from "@/lib/ids";
import { suggestionHref, type OpenSuggestion } from "@/lib/suggestions";
import { Button } from "../ui/button";
import { useAskApi } from "./ask-api";

export type ProtocolSuggestions = { available: boolean; open: readonly OpenSuggestion[] };

// "Suggest an edit" on a protocol page: the AI reads the lab's files about it and drafts a new
// version beside this one, which waits on its own page for someone to approve.
export function SuggestEditButton({ protocolId, suggestions }: { protocolId: ProtocolId; suggestions: ProtocolSuggestions }) {
  const api = useAskApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!suggestions.available) return null;
  async function draft() {
    setBusy(true);
    try {
      const outcome = await api.suggest({ kind: "protocol_edit", protocolId, questionId: null });
      if (outcome.kind === "created") {
        router.push(suggestionHref(outcome.id));
        return;
      }
      toast(outcome.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't draft an edit.");
    }
    setBusy(false);
  }
  return (
    <Button variant="tertiary" size="compact" disabled={busy} onClick={() => void draft()}>
      {busy ? "Reading the lab's files…" : "Suggest an edit"}
    </Button>
  );
}

export function WaitingEdits({ suggestions }: { suggestions: ProtocolSuggestions }) {
  if (suggestions.open.length === 0) return null;
  return (
    <ul className="mt-6 space-y-1">
      {suggestions.open.map((s) => (
        <li key={s.id}>
          <Link href={suggestionHref(s.id)} className="block rounded-control border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-secondary hover:text-content-primary">
            <span className="text-content-primary">Suggested edit waiting for approval.</span> {s.summary}
          </Link>
        </li>
      ))}
    </ul>
  );
}
