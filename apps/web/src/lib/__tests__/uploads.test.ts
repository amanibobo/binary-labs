import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { FileLocation } from "../domain";
import { openTarget } from "../format";
import { Sha256 } from "../ids";
import {
  capturedName,
  deliveryFor,
  MyUploadsRows,
  parseUploadHeaders,
  refusedKind,
  uploadHeaders,
  uploadKey,
  type UploadMeta,
} from "../uploads";

vi.mock("server-only", () => ({}));
const { receiveUpload } = await import("../upload-receive");
const { localPath } = await import("../object-store");

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe("receiveUpload", () => {
  it("hashes and stores the body, and the same bytes always hash the same", async () => {
    const data = bytes(3000);
    const a = await receiveUpload(streamOf([data.slice(0, 1000), data.slice(1000)]), { maxBytes: 4096, declaredBytes: 3000 });
    const b = await receiveUpload(streamOf([data]), { maxBytes: 4096, declaredBytes: 3000 });
    if (a.kind !== "received" || b.kind !== "received") throw new Error(`expected both received: ${a.kind}, ${b.kind}`);
    expect(a.sha256).toBe(sha(data));
    expect(b.sha256).toBe(a.sha256);
    expect(a.size).toBe(3000);
    expect(new Uint8Array(await readFile(a.path))).toEqual(data);
    await a.cleanup();
    await b.cleanup();
    await expect(readFile(a.path)).rejects.toThrow();
  });

  it("refuses an oversize body up front when it says so, and mid-stream when it lies", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(bytes(1024));
      },
    });
    expect(await receiveUpload(streamOf([bytes(10)]), { maxBytes: 4096, declaredBytes: 5000 })).toEqual({ kind: "too_large" });
    expect(await receiveUpload(endless, { maxBytes: 4096, declaredBytes: 100 })).toEqual({ kind: "too_large" });
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it("tells a cut-off body from an empty one", async () => {
    expect(await receiveUpload(streamOf([bytes(10)]), { maxBytes: 4096, declaredBytes: 20 })).toEqual({ kind: "truncated" });
    expect(await receiveUpload(streamOf([]), { maxBytes: 4096, declaredBytes: 0 })).toEqual({ kind: "empty" });
  });
});

describe("upload headers", () => {
  const meta: UploadMeta = { name: "Gel ünïcode #3.jpg", experiment: "P450 / BM3", uploadedOn: "2026-11-04", modifiedAt: 1_762_000_000_000 };

  it("round-trip through encoding", () => {
    expect(parseUploadHeaders(new Headers(uploadHeaders(meta)))).toEqual(meta);
    expect(parseUploadHeaders(new Headers(uploadHeaders({ ...meta, experiment: null, modifiedAt: null })))).toEqual({
      ...meta,
      experiment: null,
      modifiedAt: null,
    });
  });

  it("refuse a missing name or a bad date", () => {
    expect(parseUploadHeaders(new Headers({ "x-upload-date": "2026-11-04" }))).toBeNull();
    expect(parseUploadHeaders(new Headers({ "x-upload-name": "a.jpg", "x-upload-date": "11/04/2026" }))).toBeNull();
    expect(parseUploadHeaders(new Headers({ "x-upload-name": "%E0%A4%A", "x-upload-date": "2026-11-04" }))).toBeNull();
  });
});

describe("storage keys", () => {
  const lab = "11111111-1111-4111-8111-111111111111";
  const digest = Sha256.parse("a".repeat(64));

  it("put every upload under its lab's prefix", () => {
    expect(uploadKey(lab, digest)).toBe(`${lab}/files/${digest}`);
  });

  it("never resolve outside the local store", () => {
    expect(localPath("/store", uploadKey(lab, digest))).toBe(`/store/${lab}/files/${digest}`);
    expect(localPath("/store", "../etc/passwd")).toBeNull();
    expect(localPath("/store", `${lab}/../../etc/passwd`)).toBeNull();
  });
});

describe("delivering a stored file", () => {
  it("shows images, PDFs and text inline and downloads anything that could run script", () => {
    expect(deliveryFor("image/jpeg", "gel.jpg")).toEqual({
      contentType: "image/jpeg",
      disposition: `inline; filename="gel.jpg"; filename*=UTF-8''gel.jpg`,
    });
    for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml", null]) {
      expect(deliveryFor(mime, "x").contentType).toBe("application/octet-stream");
      expect(deliveryFor(mime, "x").disposition.startsWith("attachment;")).toBe(true);
    }
    expect(deliveryFor("application/pdf", 'Gel "3".pdf').disposition).toBe(
      `inline; filename="Gel _3_.pdf"; filename*=UTF-8''Gel%20%223%22.pdf`,
    );
  });
});

describe("what an upload accepts and how it names captures", () => {
  it("refuses video and audio only", () => {
    expect(refusedKind("video/quicktime")).not.toBeNull();
    expect(refusedKind("audio/mpeg")).not.toBeNull();
    expect(refusedKind("image/heic")).toBeNull();
    expect(refusedKind("application/pdf")).toBeNull();
  });

  it("gives each camera capture and pasted screenshot its own dated name", () => {
    const at = new Date(2026, 10, 4, 9, 5, 7);
    expect(capturedName("photo", at, "image/jpeg")).toBe("Photo 2026-11-04 09.05.07.jpg");
    expect(capturedName("screenshot", at, "image/png")).toBe("Screenshot 2026-11-04 09.05.07.png");
  });
});

describe("my_uploads rows", () => {
  const base = {
    location_id: "22222222-2222-4222-8222-222222222222",
    name: "gel.jpg",
    experiment: "P450 BM3",
    uploaded_at: "2026-11-04T10:00:00Z",
    index_error: null,
    has_preview: false,
  };
  const label = {
    status: "check",
    clean_name: "P450 BM3 gel",
    date: "2026-11-04",
    experiment: null,
    person: null,
    instrument: null,
    tags: [],
    confidence: 0.6,
  };

  it("say how far each upload has got", () => {
    const rows = MyUploadsRows.parse([
      { ...base, sha256: null, index_state: "pending", file_kind: null, label: null },
      { ...base, sha256: "b".repeat(64), index_state: "indexed", file_kind: "image", label: null },
      { ...base, sha256: "b".repeat(64), index_state: "indexed", file_kind: "image", label },
      { ...base, sha256: null, index_state: "failed", index_error: "preview: broken", file_kind: null, label: null },
    ]);
    expect(rows.map((r) => r.progress.kind)).toEqual(["reading", "labeling", "labeled", "failed"]);
  });
});

describe("opening a file", () => {
  const location = (kind: string) =>
    FileLocation.parse({
      id: "33333333-3333-4333-8333-333333333333",
      source_id: "44444444-4444-4444-8444-444444444444",
      source_kind: kind,
      path: "/Uploads/P450 BM3/gel.jpg",
      original_name: "gel.jpg",
      modified_at: "2026-11-04T10:00:00Z",
    });

  it("sends uploads to our store and Dropbox files to Dropbox", () => {
    expect(openTarget(location("upload"))).toEqual({ href: "/api/files/33333333-3333-4333-8333-333333333333", label: "Open file" });
    expect(openTarget(location("dropbox"))?.href).toBe("https://www.dropbox.com/home/Uploads/P450%20BM3/gel.jpg");
    expect(openTarget(location("local"))).toBeNull();
  });
});
