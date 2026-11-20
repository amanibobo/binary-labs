"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type { RunRecord } from "@/lib/run-record";
import { ConfirmedCause, SuspectedCause, type Write } from "./failure/cause";
import { TypePicker } from "./failure/type-picker";
import { useRunsApi } from "./runs-api";
import { RunSection, type RunSectionSlot } from "./section";

// Slice A's place on the run page, shown when a run failed or was odd: what someone thinks went
// wrong, the cause once a person confirmed it, and the failure type from the fixed list.
export const FailureSection: RunSectionSlot = ({ run, onChange }) => {
  const api = useRunsApi();
  const [busy, setBusy] = useState(false);
  const list = useQuery({ queryKey: ["failure-list"], queryFn: ({ signal }) => api.failureList(signal), staleTime: Infinity });
  const people = useQuery({ queryKey: ["confirmer-choices", run.id], queryFn: ({ signal }) => api.confirmerChoices(run.id, signal), staleTime: 60_000 });

  // One write at a time; a refusal says why in the database's own plain words.
  const write: Write = async (action: () => Promise<RunRecord>) => {
    setBusy(true);
    try {
      onChange(await action());
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <RunSection title="What went wrong" note="Write down what you think happened. Once something shows the cause, confirm it and name who confirmed it.">
      <div className="grid gap-8">
        <SuspectedCause key={`suspected-${run.failure.suspectedCause ?? ""}`} run={run} disabled={busy} write={write} />
        <ConfirmedCause run={run} people={people.data} disabled={busy} write={write} />
        <TypePicker run={run} list={list.data} disabled={busy} write={write} />
      </div>
    </RunSection>
  );
};
