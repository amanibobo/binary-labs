"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dataRow, dataSurface } from "@/components/ui/data-table";
import { Input, Label } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { filesLine, PAIRING_MINUTES, seenLine, type Instrument } from "@/lib/instruments";
import { addInstrument, renewPairingCode, revokeInstrument, type AddInstrumentState, type PairingCode } from "./actions";

type Props = { instruments: Instrument[]; isAdmin: boolean; shownCode: PairingCode | null };

function stateLine(instrument: Instrument): string {
  const { state, files } = instrument;
  switch (state.kind) {
    case "paired":
      return `${seenLine(state.seenSecondsAgo)} · ${filesLine(files)}`;
    case "waiting":
      return "Waiting for its PC to pair";
    case "expired":
      return "The pairing code ran out";
    case "revoked":
      return files === 0 ? "Revoked" : `Revoked · ${files === 1 ? "its file stays" : `its ${files.toLocaleString("en-US")} files stay`}`;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function InstrumentsSection({ instruments, isAdmin, shownCode }: Props) {
  const [pairing, setPairing] = useState<PairingCode | null>(shownCode);
  const shown = pairing === null ? undefined : instruments.find((i) => i.id === pairing.instrumentId);
  const router = useRouter();
  const waitingForPair = shown !== undefined && shown.state.kind !== "paired" && shown.state.kind !== "revoked";

  // While a code is on screen, check for its PC every few seconds so "Paired" shows by itself.
  useEffect(() => {
    if (!waitingForPair) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [waitingForPair, router]);

  return (
    <div className="grid gap-6">
      {pairing === null ? null : (
        <PairingPanel pairing={pairing} paired={shown?.state.kind === "paired"} onDone={() => setPairing(null)} />
      )}
      <div className={dataSurface}>
        {instruments.length === 0 ? (
          <p className="px-5 py-4 text-paragraph-medium text-content-tertiary sm:px-6">
            {isAdmin ? "No instruments yet. Add one, then pair its PC." : "No instruments yet. An admin can add one."}
          </p>
        ) : (
          <ul>
            {instruments.map((instrument) => (
              <li key={instrument.id} className={cn(dataRow, "flex min-h-14 items-center gap-3 py-2 pr-3 pl-5 sm:pl-6")}>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-paragraph-medium",
                      instrument.state.kind === "revoked" ? "text-content-tertiary" : "text-content-primary",
                    )}
                  >
                    {instrument.name}
                  </span>
                  <span className="block truncate text-paragraph-small text-content-tertiary">{stateLine(instrument)}</span>
                </span>
                {isAdmin ? <RowActions instrument={instrument} onCode={setPairing} /> : null}
              </li>
            ))}
          </ul>
        )}
        {isAdmin ? <AddForm onAdded={setPairing} /> : null}
      </div>
    </div>
  );
}

function RowActions({ instrument, onCode }: { instrument: Instrument; onCode: (pairing: PairingCode) => void }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const { state } = instrument;
  if (state.kind === "revoked") return null;
  const unpaired = state.kind === "waiting" || state.kind === "expired";
  if (confirming) {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <Button type="button" variant="tertiary" size="compact" disabled={pending} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="compact"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await revokeInstrument(instrument.id);
              if (result.kind === "error") toast.error(result.message);
              setConfirming(false);
            })
          }
        >
          Revoke<span className="sr-only"> {instrument.name}</span> now
        </Button>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      {unpaired ? (
        <Button
          type="button"
          variant="tertiary"
          size="compact"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await renewPairingCode(instrument.id, instrument.name);
              if (result.kind === "error") toast.error(result.message);
              else onCode(result.pairing);
            })
          }
        >
          New code<span className="sr-only"> for {instrument.name}</span>
        </Button>
      ) : null}
      <Button type="button" variant="tertiary" size="compact" disabled={pending} onClick={() => setConfirming(true)}>
        Revoke<span className="sr-only"> {instrument.name}</span>
      </Button>
    </span>
  );
}

function AddForm({ onAdded }: { onAdded: (pairing: PairingCode) => void }) {
  const [state, action, pending] = useActionState<AddInstrumentState, FormData>(async (prev, form) => {
    const next = await addInstrument(prev, form);
    if (next.kind === "added") onAdded(next.pairing);
    return next;
  }, { kind: "idle" });
  const id = useId();
  const error = state.kind === "error" ? state : null;
  return (
    <form action={action} className="border-t border-border-opaque px-5 py-4 sm:px-6" key={state.kind === "added" ? state.pairing.instrumentId : "draft"}>
      <Label htmlFor={`${id}-name`}>Add an instrument</Label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <Input
          id={`${id}-name`}
          name="name"
          autoComplete="off"
          placeholder="Name and room, like Plate reader, room 214"
          defaultValue={error?.name ?? ""}
          aria-invalid={error !== null}
          aria-describedby={`${id}-status`}
          maxLength={80}
          required
        />
        <Button type="submit" variant="secondary" disabled={pending} className="sm:w-auto">
          {pending ? "Adding" : "Add"}
        </Button>
      </div>
      <p id={`${id}-status`} role="status" className="mt-2 text-paragraph-small text-content-tertiary">
        {error?.message ?? "You'll get a code to pair the instrument's PC with."}
      </p>
    </form>
  );
}

function Command({ text }: { text: string }) {
  return (
    <span className="mt-1.5 flex items-center gap-2 rounded-control border border-border-opaque bg-background-secondary py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-paragraph-small whitespace-nowrap text-content-primary">{text}</code>
      <Button
        type="button"
        variant="tertiary"
        size="compact"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => toast.success("Copied"),
            () => toast.error("Select the text and copy it instead."),
          );
        }}
      >
        Copy
      </Button>
    </span>
  );
}

function PairingPanel({ pairing, paired, onDone }: { pairing: PairingCode; paired: boolean; onDone: () => void }) {
  const exe = "binary-labs-uploader";
  return (
    <section aria-labelledby="pairing-title" className={cn(dataSurface, "p-5 sm:p-6")}>
      <h2 id="pairing-title" className="text-heading-xsmall text-content-primary">
        Pair {pairing.name}
      </h2>
      {paired ? (
        <p role="status" className="mt-2 text-paragraph-medium text-content-secondary">
          Paired. New files from it will show up under Browse in Instruments/{pairing.name}.
        </p>
      ) : (
        <>
          <p className="mt-1 text-paragraph-medium text-content-tertiary">
            The code works once, for {PAIRING_MINUTES} minutes. Only you see it.
          </p>
          <p className="mt-4 font-mono text-heading-medium tracking-wide text-content-primary" aria-label={`Pairing code ${pairing.code.split("").join(" ")}`}>
            {pairing.code}
          </p>
          <ol className="mt-5 grid grid-cols-1 list-decimal gap-4 pl-5 text-paragraph-medium text-content-secondary marker:text-content-tertiary">
            <li>
              Copy <span className="font-mono text-paragraph-small text-content-primary">{exe}.exe</span> to the instrument PC, for example into
              C:\Program Files\Binary.
            </li>
            <li>
              In Command Prompt on that PC, pair it:
              <Command text={`${exe} pair ${pairing.server} ${pairing.code}`} />
            </li>
            <li>
              Tell it the folder the instrument saves files to:
              <Command text={`${exe} add-folder "D:\\Instrument data"`} />
            </li>
            <li>
              Start it. To have it start with Windows, follow the uploader&apos;s README.
              <Command text={`${exe} run`} />
            </li>
          </ol>
        </>
      )}
      <Button type="button" variant={paired ? "primary" : "secondary"} className="mt-6" onClick={onDone}>
        Done
      </Button>
    </section>
  );
}
