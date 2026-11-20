import { buttonVariants } from "@/components/ui/button";
import type { Budget } from "@/lib/answers";
import { AiLimitRow } from "./ai-limit-section";
import { DeleteLabRow } from "./delete-lab-section";
import { SettingsGroup, SettingsRow } from "./settings-frame";

export function GeneralSection({ labName, isAdmin, budget }: { labName: string; isAdmin: boolean; budget: Budget | null }) {
  return (
    <>
      <SettingsGroup>
        <SettingsRow label="Lab name" action={<span className="text-paragraph-medium text-content-secondary">{labName}</span>} />
        <SettingsRow
          label="Download protocols"
          action={
            // A plain link: the route answers with a file to save.
            <a href="/api/protocols/export" download className={buttonVariants({ variant: "secondary", size: "compact" })}>
              Download
            </a>
          }
        >
          Every protocol and tutorial in one Markdown file.
        </SettingsRow>
        {budget === null ? null : <AiLimitRow budget={budget} isAdmin={isAdmin} />}
      </SettingsGroup>
      {isAdmin ? <DeleteLabRow labName={labName} /> : null}
    </>
  );
}
