import { loadSourceState } from "@/lib/lab-data";
import { DropboxSection } from "../dropbox-section";
import { DropboxNotice } from "../sections";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("dropbox");

// A Dropbox sign-in comes back here, with ?dropbox=<notice> when it didn't connect.
export default async function DropboxPage({ searchParams }: PageProps<"/settings/dropbox">) {
  const { dropbox } = await searchParams;
  const notice = dropbox === undefined ? null : DropboxNotice.parse(dropbox);
  return renderSettings("dropbox", async ({ supabase, lab }) => (
    <DropboxSection initial={await loadSourceState(supabase, lab.id)} isAdmin={lab.role === "admin"} notice={notice} />
  ));
}
