import { describe, expect, it } from "vitest";
import { uploaderDownload } from "../uploader-download";

describe("where the Windows uploader downloads from", () => {
  it("is the configured https address", () => {
    expect(uploaderDownload({ UPLOADER_DOWNLOAD_URL: " https://downloads.example.org/binary-labs-uploader.exe " })).toEqual({
      kind: "available",
      url: "https://downloads.example.org/binary-labs-uploader.exe",
    });
  });

  it("isn't available yet when unset, blank, not a link or not https", () => {
    for (const value of [undefined, "", "  ", "later", "http://downloads.example.org/u.exe", "ftp://x/u.exe"]) {
      expect(uploaderDownload({ UPLOADER_DOWNLOAD_URL: value })).toEqual({ kind: "not_yet" });
    }
  });
});
