import { buttonVariants } from "@/components/ui/button";
import { DeleteLabRow } from "./delete-lab-section";
import { SettingsGroup, SettingsRow } from "./settings-frame";

export function GeneralSection({ labName, isAdmin }: { labName: string; isAdmin: boolean }) {
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
      </SettingsGroup>
      {isAdmin ? <DeleteLabRow labName={labName} /> : null}
    </>
  );
}
