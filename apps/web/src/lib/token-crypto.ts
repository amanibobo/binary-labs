import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Layout shared with the worker (design.md, Secrets): nonce(12) || ciphertext || tag(16).
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function encryptToken({ key, plaintext, nonce = randomBytes(NONCE_BYTES) }: {
  key: Buffer;
  plaintext: string;
  nonce?: Buffer;
}): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

export function decryptToken({ key, blob }: { key: Buffer; blob: Buffer }): string {
  if (blob.length < NONCE_BYTES + TAG_BYTES) throw new Error("token blob is too short");
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// PostgREST reads and writes bytea as "\x" followed by hex.
export function toPgBytea(blob: Buffer): string {
  return `\\x${blob.toString("hex")}`;
}

export function fromPgBytea(text: string): Buffer {
  if (!/^\\x(?:[0-9a-f]{2})*$/i.test(text)) throw new Error("not a hex bytea value");
  return Buffer.from(text.slice(2), "hex");
}
