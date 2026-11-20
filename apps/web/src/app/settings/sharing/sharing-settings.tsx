"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SHARING_AGREEMENT, type LabSharing, type SharingLogEntry } from "@/components/runs/api/sharing";
import { useRunsApi } from "@/components/runs/runs-api";
import { SharingHistory } from "@/components/runs/sharing-section";
import { Button } from "@/components/ui/button";
import { dataRow, dataSurface } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDock } from "@/components/ui/dialog";
import { When } from "@/components/ui/when";
import { cn } from "@/lib/cn";
import { SettingsGroup, SettingsRow } from "../settings-frame";

// The lab's side of sharing: the agreement's wording, whether an admin has agreed to it, and
// for admins the lab's sharing history. `initialLog` is null for a member who isn't an admin.
export function SharingSettings({ initial, initialLog }: { initial: LabSharing; initialLog: SharingLogEntry[] | null }) {
  const api = useRunsApi();
  const [sharing, setSharing] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [log, setLog] = useState(initialLog);

  const set = async (on: boolean) => {
    setBusy(true);
    try {
      setSharing(await api.setLabShare(on, SHARING_AGREEMENT.version));
      setAsking(false);
      setLog(await api.sharingLog(null, new AbortController().signal));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const agreed = sharing.agreedAt !== null;
  const current = sharing.agreement === SHARING_AGREEMENT.version;

  return (
    <>
      <SettingsGroup title="The sharing agreement" description={SHARING_AGREEMENT.draftNote}>
        <div className={cn(dataRow, "grid gap-3 px-5 py-4 text-paragraph-medium text-content-secondary sm:px-6")}>
          {SHARING_AGREEMENT.paragraphs.map((paragraph) => (
            <p key={paragraph} className="max-w-prose">
              {paragraph}
            </p>
          ))}
          <p className="text-paragraph-small text-content-tertiary">Wording {SHARING_AGREEMENT.version}</p>
        </div>
        {sharing.demo ? (
          <SettingsRow label="This is a demo lab">Its data is made up and is marked SAMPLE wherever it&rsquo;s shown, so nothing is shared from it.</SettingsRow>
        ) : (
          <SettingsRow
            label={agreed ? "The lab has agreed" : "The lab hasn't agreed"}
            action={
              !sharing.canChange ? null : (
                <>
                  {agreed && current ? null : (
                    <Button type="button" size="compact" disabled={busy} onClick={() => void set(true)}>
                      {agreed ? "Agree to this wording" : "Agree for the lab"}
                    </Button>
                  )}
                  {agreed ? (
                    <Button type="button" variant="negative" size="compact" disabled={busy} onClick={() => setAsking(true)}>
                      Take back the agreement
                    </Button>
                  ) : null}
                </>
              )
            }
          >
            {sharing.agreedAt === null ? (
              <p>Nothing leaves the lab. {sharing.canChange ? "Agreeing doesn't share anything by itself: each run also has its own switch, which starts off." : "Only an admin can agree for the lab."}</p>
            ) : (
              <>
                <p>
                  {sharing.agreedBy ?? "An admin"} agreed on <When iso={sharing.agreedAt} />, to wording {sharing.agreement}.
                </p>
                {current ? null : <p className="mt-1">The wording has changed since then. Read it above and agree again.</p>}
                <p className="mt-1">A run is shared only if its own switch is on too.{sharing.canChange ? "" : " Only an admin can take the agreement back."}</p>
              </>
            )}
          </SettingsRow>
        )}
      </SettingsGroup>

      {log === null ? null : (
        <section aria-label="Sharing history">
          <div className="mb-3">
            <h2 className="text-label-large text-content-primary">Sharing history</h2>
            <p className="mt-0.5 text-paragraph-small text-content-tertiary">Every change to sharing and every attempt to export a run, newest first.</p>
          </div>
          {log.length === 0 ? (
            <p className={cn(dataSurface, "px-5 py-4 text-paragraph-small text-content-tertiary sm:px-6")}>Nothing yet.</p>
          ) : (
            <SharingHistory log={log} subject={(entry) => (entry.runTitle === null ? "a run" : `the run ${entry.runTitle}`)} />
          )}
        </section>
      )}

      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent title="Take back the lab's agreement?" aria-describedby={undefined}>
          <div className="grid gap-3 px-4 pt-3 text-paragraph-medium text-content-secondary sm:px-6">
            <p>Sharing stops for every run in the lab, including runs whose own switch is on.</p>
            <p>Binary removes any task folders it built from the lab&rsquo;s runs. If anything was already sent to someone else, those copies can&rsquo;t be pulled back.</p>
          </div>
          <DialogDock className="pt-5">
            <Button type="button" variant="negative" disabled={busy} onClick={() => void set(false)}>
              {busy ? "Taking it back" : "Take back the agreement"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setAsking(false)}>
              Keep the agreement
            </Button>
          </DialogDock>
        </DialogContent>
      </Dialog>
    </>
  );
}
