import { redirect } from "next/navigation";
import { DROPBOX_FOLDER_HREF } from "@/app/settings/sections";

// The folder picker moved under Settings > Dropbox.
export default function LegacyFolderPage() {
  redirect(DROPBOX_FOLDER_HREF);
}
