import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { Sha256 } from "./ids";

export type Received =
  | { kind: "received"; sha256: Sha256; size: number; path: string; cleanup: () => Promise<void> }
  | { kind: "too_large" }
  // The body ended short of its Content-Length: a dropped connection, not a file.
  | { kind: "truncated" }
  | { kind: "empty" };

// Streams a request body to a temp file, hashing as it goes, and stops reading the moment it
// passes the cap, so an oversize upload never fills the disk or memory.
export async function receiveUpload(
  body: ReadableStream<Uint8Array> | null,
  { maxBytes, declaredBytes }: { maxBytes: number; declaredBytes: number },
): Promise<Received> {
  if (declaredBytes > maxBytes) return { kind: "too_large" };
  if (body === null || declaredBytes === 0) return { kind: "empty" };

  const dir = await mkdtemp(join(tmpdir(), "bl-upload-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const path = join(dir, randomUUID());
  const out = createWriteStream(path);
  const hash = createHash("sha256");
  let size = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        out.destroy();
        await cleanup();
        return { kind: "too_large" };
      }
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    await cleanup();
    throw err;
  }
  if (size !== declaredBytes) {
    await cleanup();
    return size === 0 ? { kind: "empty" } : { kind: "truncated" };
  }
  return { kind: "received", sha256: Sha256.parse(hash.digest("hex")), size, path, cleanup };
}
