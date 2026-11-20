import { createHash } from "node:crypto";
import type { Sha256 } from "./ids";

// A kept version is handed over only after its stored bytes hash to the version's sha256,
// so what opens is what was read, or nothing.
export async function bytesMatch(bytes: AsyncIterable<Uint8Array>, sha256: Sha256): Promise<boolean> {
  const hash = createHash("sha256");
  for await (const chunk of bytes) hash.update(chunk);
  return hash.digest("hex") === sha256;
}
