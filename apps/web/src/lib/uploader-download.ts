import { z } from "zod";

// Where the Windows uploader can be downloaded. CI builds the exe as an artifact; until it has a
// public home, UPLOADER_DOWNLOAD_URL is unset and the page says it isn't available yet.

export const UPLOADER_EXE = "binary-labs-uploader.exe";
export const UPLOADER_DOWNLOAD_HREF = "/settings/instruments/download";

export type UploaderDownload = { kind: "available"; url: string } | { kind: "not_yet" };

const DownloadUrl = z.url({ protocol: /^https$/ });

export function uploaderDownload(source: Record<string, string | undefined> = process.env): UploaderDownload {
  const raw = source.UPLOADER_DOWNLOAD_URL?.trim() ?? "";
  const url = DownloadUrl.safeParse(raw);
  return url.success ? { kind: "available", url: url.data } : { kind: "not_yet" };
}
