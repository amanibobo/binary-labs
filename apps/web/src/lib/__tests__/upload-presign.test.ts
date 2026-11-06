import { describe, expect, it, vi } from "vitest";
import { UPLOAD_MAX_BYTES } from "../uploads";

// With R2 as the store, starting an upload signs a PUT and nothing else: no request leaves
// this process (signing is local), and the URL can only write the staging key it names.

vi.mock("server-only", () => ({}));
Object.assign(process.env, {
  PREVIEW_STORE: "r2",
  R2_ACCOUNT_ID: "acct0123",
  R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "binary-test",
});
const { startUpload } = await import("../upload-accept");

const LAB = "11111111-1111-4111-8111-111111111111";

describe("a presigned upload", () => {
  it("lets the browser PUT one file of the agreed size and type to the lab's staging key", async () => {
    const started = await startUpload(LAB, { purpose: "file", size: 4_800_000, type: "image/jpeg" });
    if (!("session" in started)) throw new Error(JSON.stringify(started));
    const { uploadId, url, headers } = started.session;
    const signed = new URL(url);
    expect(signed.origin).toBe("https://binary-test.acct0123.r2.cloudflarestorage.com");
    expect(signed.pathname).toBe(`/${LAB}/uploads/${uploadId}`);
    expect(signed.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(["content-length", "content-type", "host"]);
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(signed.searchParams.get("x-id")).toBe("PutObject");
    expect(headers).toEqual({ "content-type": "image/jpeg" });
  });

  it("gives every upload its own key", async () => {
    const a = await startUpload(LAB, { purpose: "talk-through", size: 10, type: "audio/mp4" });
    const b = await startUpload(LAB, { purpose: "talk-through", size: 10, type: "audio/mp4" });
    if (!("session" in a) || !("session" in b)) throw new Error("expected sessions");
    expect(a.session.uploadId).not.toBe(b.session.uploadId);
    expect(new URL(a.session.url).pathname).not.toBe(new URL(b.session.url).pathname);
  });

  it("signs nothing for a file the server would refuse", async () => {
    const big = await startUpload(LAB, { purpose: "file", size: UPLOAD_MAX_BYTES + 1, type: "image/jpeg" });
    const video = await startUpload(LAB, { purpose: "file", size: 10, type: "video/mp4" });
    const notSound = await startUpload(LAB, { purpose: "talk-through", size: 10, type: "image/png" });
    expect([big, video, notSound].map((r) => ("session" in r ? "signed" : r.status))).toEqual([413, 415, 415]);
  });
});
