"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { When } from "@/components/ui/when";
import { cn } from "@/lib/cn";
import { blockWords, folderCount, RUN_SHARE_DRAFT_NOTE, RUN_SHARE_MEANING, SENT_COPIES_LINE, sharingLogLine, type RunSharing, type SharingLogEntry } from "./api/sharing";
import { Button } from "../ui/button";
import { dataRow, dataSurface } from "../ui/data-table";
import { useRunsApi } from "./runs-api";
import { RunSection, type RunSectionProps } from "./section";

const SHORT_HISTORY = 5;

// Who changed sharing and who asked to export, newest first. `subject` names the run in each
// line: "this run" on its own page, its title in the lab's log.
export function SharingHistory({ log, subject }: { log: readonly SharingLogEntry[]; subject: (entry: SharingLogEntry) => string }) {
  const [all, setAll] = useState(false);
  const shown = all ? log : log.slice(0, SHORT_HISTORY);
  return (
    <>
      <ul className={dataSurface}>
        {shown.map((entry) => (
          <li key={entry.id} className={cn(dataRow, "px-4 py-2.5")}>
            <p className="text-paragraph-small text-content-primary [overflow-wrap:anywhere]">{sharingLogLine(entry, subject(entry))}</p>
            <p className="text-paragraph-xsmall text-content-tertiary">
              <When iso={entry.at} />
            </p>
          </li>
        ))}
      </ul>
      {log.length > SHORT_HISTORY && !all ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-2 inline-flex min-h-7 items-center rounded-md px-1.5 text-label-small text-content-primary transition-colors duration-150 ease-out hover:bg-background-tertiary max-sm:min-h-11"
        >
          Show all {log.length}
        </button>
      ) : null}
    </>
  );
}

// The run's sharing switch, off unless the person who ran it or an admin turned it on, what
// still stops the run leaving the lab, and who changed what.
export function SharingSection({ run, onChange }: RunSectionProps) {
  const api = useRunsApi();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Any change to the run can turn its sharing off, so both reads follow the run.
  const sharing = useQuery({ queryKey: ["run-sharing", run.id, run.updatedAt], queryFn: ({ signal }) => api.runSharing(run.id, signal), placeholderData: (previous) => previous });
  const log = useQuery({ queryKey: ["run-sharing-log", run.id, run.updatedAt], queryFn: ({ signal }) => api.sharingLog(run.id, signal), placeholderData: (previous) => previous });

  const set = async (on: boolean) => {
    setBusy(true);
    try {
      onChange(await api.setRunShare(run.id, on));
      setConfirming(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <RunSection
      title="Sharing"
      note={
        <>
          {RUN_SHARE_MEANING} <span className="text-content-tertiary">{RUN_SHARE_DRAFT_NOTE}</span>
        </>
      }
    >
      {sharing.data === undefined ? (
        sharing.isError ? <p className="text-paragraph-small text-content-secondary">We couldn&rsquo;t load this run&rsquo;s sharing. Reload the page to try again.</p> : null
      ) : (
        <Switch
          sharing={sharing.data}
          on={sharing.data.share}
          ranBy={run.person?.name ?? null}
          busy={busy}
          confirming={confirming}
          onTurnOn={() => void set(true)}
          onTurnOff={() => (sharing.data.built > 0 ? setConfirming(true) : void set(false))}
          onConfirm={() => void set(false)}
          onCancel={() => setConfirming(false)}
        />
      )}
      {log.data === undefined || log.data.length === 0 ? null : (
        <div className="mt-5">
          <h3 className="mb-2 text-label-small text-content-secondary">Sharing history</h3>
          <SharingHistory log={log.data} subject={() => "this run"} />
        </div>
      )}
    </RunSection>
  );
}

type SwitchProps = {
  sharing: RunSharing;
  on: boolean;
  ranBy: string | null;
  busy: boolean;
  confirming: boolean;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

function Switch({ sharing, on, ranBy, busy, confirming, onTurnOn, onTurnOff, onConfirm, onCancel }: SwitchProps) {
  const demo = sharing.blocks.includes("demo_lab");
  const others = sharing.blocks.filter((b) => b !== "run_off" && b !== "demo_lab");
  return (
    <div className="grid gap-2 text-paragraph-small text-content-secondary">
      {demo && !on ? (
        <p>This is a demo lab. Its data is made up, so nothing is ever shared from it.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-label-medium text-content-primary">{on ? "Sharing is on for this run." : "Sharing is off for this run."}</p>
          {sharing.canChange ? (
            <Button type="button" variant="secondary" size="compact" disabled={busy || confirming} onClick={on ? onTurnOff : onTurnOn}>
              {on ? "Turn sharing off" : "Turn sharing on"}
            </Button>
          ) : null}
        </div>
      )}
      {sharing.canChange || demo ? null : <p>{ranBy === null ? "Only an admin can change this." : `Only ${ranBy}, who ran it, or an admin can change this.`}</p>}
      {demo && on ? <p>Nothing leaves the lab: this is a demo lab, and its data is made up.</p> : null}
      {demo || others.length === 0 ? null : (
        <p>
          Nothing can leave the lab yet: {blockWords(others)}.
          {others.includes("lab_off") ? (
            <>
              {" "}
              An admin agrees for the lab in{" "}
              <Link href="/settings/sharing" className="text-content-primary underline decoration-content-tertiary underline-offset-4 hover:decoration-content-primary">
                Settings, Sharing
              </Link>
              .
            </>
          ) : null}
        </p>
      )}
      {on && sharing.blocks.length === 0 ? <p>This run can be shared outside the lab.</p> : null}
      {on ? <p>If anyone changes this run, sharing turns itself off until it&rsquo;s turned on again.</p> : null}
      {sharing.withdrawn === 0 ? null : (
        <p>
          {folderCount(sharing.withdrawn)} built from this run {sharing.withdrawn === 1 ? "was" : "were"} withdrawn. {SENT_COPIES_LINE}
        </p>
      )}
      {confirming ? (
        <div role="alertdialog" aria-label="Turn sharing off?" className="mt-1 rounded-card border border-border-opaque bg-background-secondary px-4 py-3">
          <p className="max-w-prose text-content-primary">
            Binary built {folderCount(sharing.built)} from this run. Turning sharing off removes {sharing.built === 1 ? "the copy" : "the copies"} Binary holds.{" "}
            {SENT_COPIES_LINE}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="negative" size="compact" disabled={busy} onClick={onConfirm}>
              Turn sharing off
            </Button>
            <Button type="button" variant="secondary" size="compact" onClick={onCancel}>
              Keep it on
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
