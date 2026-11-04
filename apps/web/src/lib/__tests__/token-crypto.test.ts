import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decryptToken, encryptToken, fromPgBytea, toPgBytea } from "../token-crypto";

const Vector = z.object({ key_b64: z.base64(), plaintext: z.string(), blob_hex: z.string() });
const vector = Vector.parse(
  JSON.parse(readFileSync(join(__dirname, "../../../../../db/test/token_vector.json"), "utf8")),
);
const key = Buffer.from(vector.key_b64, "base64");
const blob = Buffer.from(vector.blob_hex, "hex");

describe("token crypto", () => {
  it("decrypts the shared vector", () => {
    expect(decryptToken({ key, blob })).toBe(vector.plaintext);
  });

  it("encrypts to the exact shared vector bytes with its nonce", () => {
    const nonce = blob.subarray(0, 12);
    expect(encryptToken({ key, plaintext: vector.plaintext, nonce }).toString("hex")).toBe(vector.blob_hex);
  });

  it("uses a fresh nonce each time and still round-trips", () => {
    const a = encryptToken({ key, plaintext: "abc" });
    const b = encryptToken({ key, plaintext: "abc" });
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
    expect(decryptToken({ key, blob: a })).toBe("abc");
  });

  it("rejects a tampered ciphertext", () => {
    const tampered = Buffer.from(blob);
    tampered[14] = (tampered[14] ?? 0) ^ 1;
    expect(() => decryptToken({ key, blob: tampered })).toThrow();
  });

  it("rejects the wrong key", () => {
    expect(() => decryptToken({ key: Buffer.alloc(32, 1), blob })).toThrow();
  });

  it("round-trips through the PostgREST bytea text form", () => {
    expect(toPgBytea(blob)).toBe(`\\x${vector.blob_hex}`);
    expect(fromPgBytea(toPgBytea(blob)).equals(blob)).toBe(true);
    expect(() => fromPgBytea("0909")).toThrow();
  });
});
