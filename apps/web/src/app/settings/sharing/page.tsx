import { loadLabSharing, loadSharingLog } from "@/lib/run-sharing-store";
import { renderSettings, settingsMetadata } from "../settings-shell";
import { SharingSettings } from "./sharing-settings";

export const metadata = settingsMetadata("sharing");

export default function SharingPage() {
  return renderSettings("sharing", async ({ supabase, lab }) => {
    const [sharing, log] = await Promise.all([loadLabSharing(supabase, lab.id), lab.role === "admin" ? loadSharingLog(supabase, lab.id, null) : null]);
    return <SharingSettings initial={sharing} initialLog={log?.kind === "ok" ? log.value : null} />;
  });
}
