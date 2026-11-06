import { z } from "zod";
import { InstrumentId, LocationId, Sha256 } from "./ids";

// Mirrors instrument_max_bytes() in db/migrations/0013_instruments.sql; a db test checks they
// agree. Instrument exports run from a few KB to a few hundred MB, and the worker reads a whole
// file into memory, so the cap matches videos.
export const INSTRUMENT_MAX_BYTES = 500 * 1024 * 1024;
export const PAIRING_MINUTES = 15;

// Pairing codes are read off a screen and typed on another PC: Crockford's base32, which
// leaves out I, L, O and U, so nothing looks like something else.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;

export function codeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < CODE_LENGTH) throw new Error("not enough random bytes for a code");
  return Array.from(bytes.subarray(0, CODE_LENGTH), (b) => CODE_ALPHABET[b % 32]).join("");
}

// "K7QM4XPA" shows as "K7QM-4XPA".
export function displayCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// As typed: any case, with spaces or dashes, and the letters people swap for digits.
export function normalizeCode(typed: string): string | null {
  const code = typed
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

// Where a file was on the instrument PC: the watched folder's own name, then the path inside
// it, with forward slashes. Mirrors the check in record_instrument_file.
export const InstrumentPath = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (p) => p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !/[\\\p{Cc}]/u.test(seg)),
    "a path is folder/name with forward slashes",
  );

export const FileClaim = z.object({
  path: InstrumentPath,
  sha256: Sha256,
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().positive().nullable(),
});
export type FileClaim = z.infer<typeof FileClaim>;

export const PairRequest = z.object({ code: z.string().max(40) });

export const InstrumentName = z.string().trim().min(1, "Give it a name.").max(80, "Keep it to 80 characters.")
  .refine((n) => !n.includes("/") && !n.includes("\\"), "A name can't have a slash in it.");

export const RecordInstrumentFileRows = z
  .tuple([z.object({ location_id: LocationId, duplicate: z.boolean() })])
  .transform(([r]) => ({ locationId: r.location_id, duplicate: r.duplicate }));

export type InstrumentState =
  | { kind: "waiting"; expiresAt: string }
  | { kind: "expired" }
  | { kind: "paired"; pairedAt: string; seenSecondsAgo: number | null }
  | { kind: "revoked"; revokedAt: string };

export type Instrument = { id: InstrumentId; name: string; files: number; state: InstrumentState };

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

export const LabInstrumentsRows = z.array(
  z
    .object({
      id: InstrumentId,
      name: z.string(),
      state: z.enum(["waiting", "expired", "paired", "revoked"]),
      pairing_expires_at: Timestamp.nullable(),
      paired_at: Timestamp.nullable(),
      seen_seconds_ago: z.number().int().nonnegative().nullable(),
      revoked_at: Timestamp.nullable(),
      files: z.coerce.number().int().nonnegative(),
    })
    .transform((r): Instrument => ({ id: r.id, name: r.name, files: r.files, state: stateOf(r) })),
);

function stateOf(r: {
  state: "waiting" | "expired" | "paired" | "revoked";
  pairing_expires_at: string | null;
  paired_at: string | null;
  seen_seconds_ago: number | null;
  revoked_at: string | null;
}): InstrumentState {
  switch (r.state) {
    case "waiting":
      return r.pairing_expires_at === null ? { kind: "expired" } : { kind: "waiting", expiresAt: r.pairing_expires_at };
    case "expired":
      return { kind: "expired" };
    case "paired":
      return { kind: "paired", pairedAt: r.paired_at ?? "", seenSecondsAgo: r.seen_seconds_ago };
    case "revoked":
      return { kind: "revoked", revokedAt: r.revoked_at ?? "" };
    default: {
      const _exhaustive: never = r.state;
      return _exhaustive;
    }
  }
}

// "Seen 2 minutes ago". The uploader checks in every minute, so anything under two is "just now".
export function seenLine(secondsAgo: number | null): string {
  if (secondsAgo === null) return "Not seen yet";
  const minutes = Math.floor(secondsAgo / 60);
  if (minutes < 2) return "Seen just now";
  if (minutes < 60) return `Seen ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "Seen an hour ago" : `Seen ${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Seen yesterday" : `Seen ${days} days ago`;
}

export function filesLine(files: number): string {
  if (files === 0) return "No files yet";
  return files === 1 ? "1 file sent" : `${files.toLocaleString("en-US")} files sent`;
}
