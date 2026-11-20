import type { Metadata } from "next";
import { requestOrigin } from "@/lib/origin";
import { uploaderDownload } from "@/lib/uploader-download";
import { renderSettings } from "../../settings-shell";
import { UploaderDownloadSection } from "../../uploader-download-section";

export const metadata: Metadata = { title: "Instrument uploader · Settings" };

export default function UploaderDownloadPage() {
  return renderSettings("instruments", async ({ lab }) => (
    <UploaderDownloadSection download={uploaderDownload()} server={await requestOrigin()} isAdmin={lab.role === "admin"} />
  ));
}
