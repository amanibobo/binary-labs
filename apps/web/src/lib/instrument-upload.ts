import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { InstrumentId, LabId, Sha256 } from "./ids";
import type { InstrumentDb } from "./instrument-db";
import { codeFromBytes, INSTRUMENT_MAX_BYTES, normalizeCode, RecordInstrumentFileRows, type FileClaim } from "./instruments";
import { objectSize, putFile, type PartRef } from "./object-store";
import { PART_BYTES, partCount } from "./parts";
import {
  abortStaged,
  discardStaged,
  joinStaged,
  keepStaged,
  receiveStagedPart,
  stagedPartUrl,
  startStaged,
  type Refused,
  type StagedSession,
} from "./staged-upload";
import { uploadKey } from "./uploads";

// The cores of the uploader's routes (app/api/instruments/*). Nothing here reads a session:
// the uploader proves itself with a device token in the Authorization header, and session
// routes never look at that header. Codes and tokens reach the database only as sha256 hashes.

export type Answer = { status: number; body: unknown; headers?: Record<string, string> };

const TOKEN_PREFIX = "blu_";
const TOO_BIG = `Files can be up to ${INSTRUMENT_MAX_BYTES / 1024 / 1024} MB.`;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function newPairingCode(): { code: string; hash: string } {
  const code = codeFromBytes(randomBytes(8));
  return { code, hash: hashSecret(code) };
}

function newDeviceToken(): { token: string; hash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashSecret(token) };
}

// A Supabase session JWT never starts with the prefix, so one can't stand in for a token.
export function bearerToken(headers: Headers): string | null {
  const match = /^Bearer (\S+)$/.exec(headers.get("authorization") ?? "");
  const token = match?.[1];
  return token !== undefined && token.startsWith(TOKEN_PREFIX) && token.length <= 200 ? token : null;
}

// The pairing rate limit counts tries per caller, by a hash of the address the host saw.
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return hashSecret(`client:${forwarded || headers.get("x-real-ip") || "unknown"}`);
}

const PairRows = z.tuple([
  z.object({
    outcome: z.enum(["paired", "refused", "limited"]),
    paired_id: InstrumentId.nullable(),
    paired_name: z.string().nullable(),
    paired_lab_name: z.string().nullable(),
  }),
]);

const REFUSED = { status: 401, body: { error: "That code isn't right, or it was used or ran out. Ask your lab admin for a new one." } };

export async function pairInstrument(typed: string, client: string, db: InstrumentDb): Promise<Answer> {
  const code = normalizeCode(typed);
  // A code that can't be one still counts as a try, so it goes to the database too.
  const codeHash = hashSecret(code ?? `not a code:${typed}`);
  const { token, hash } = newDeviceToken();
  const { data, error } = await db.pair({ p_code_hash: codeHash, p_token_hash: hash, p_client: client });
  if (error !== null) throw new Error(`pair_instrument: ${error.message} (${error.code ?? "no code"})`);
  const [row] = PairRows.parse(data);
  switch (row.outcome) {
    case "limited":
      return { status: 429, body: { error: "Too many tries. Wait 15 minutes and try again." }, headers: { "retry-after": "900" } };
    case "refused":
      return REFUSED;
    case "paired":
      if (row.paired_id === null || row.paired_name === null) throw new Error("pair_instrument paired nothing");
      return {
        status: 200,
        body: { token, instrument: { id: row.paired_id, name: row.paired_name }, lab: { name: row.paired_lab_name ?? "" } },
      };
    default: {
      const _exhaustive: never = row.outcome;
      return _exhaustive;
    }
  }
}

export type InstrumentSession = { instrumentId: InstrumentId; labId: LabId; name: string; tokenHash: string };

const SessionRows = z.array(z.object({ instrument_id: InstrumentId, lab_id: LabId, name: z.string() }));

export const UNPAIRED: Answer = {
  status: 401,
  body: { error: "This uploader isn't paired. Ask your lab admin for a new code and pair it again." },
};

export async function authorize(headers: Headers, db: InstrumentDb): Promise<InstrumentSession | null> {
  const token = bearerToken(headers);
  if (token === null) return null;
  const tokenHash = hashSecret(token);
  const { data, error } = await db.session({ p_token_hash: tokenHash });
  if (error !== null) throw new Error(`instrument_session: ${error.message} (${error.code ?? "no code"})`);
  const [row] = SessionRows.parse(data);
  return row === undefined ? null : { instrumentId: row.instrument_id, labId: row.lab_id, name: row.name, tokenHash };
}

export function heartbeat(session: InstrumentSession): Answer {
  return {
    status: 200,
    body: { instrument: { id: session.instrumentId, name: session.name }, maxBytes: INSTRUMENT_MAX_BYTES, partBytes: PART_BYTES },
  };
}

async function record(session: InstrumentSession, claim: FileClaim, sha256: Sha256, size: number, db: InstrumentDb) {
  const { data, error } = await db.record({
    p_token_hash: session.tokenHash,
    p_path: claim.path,
    p_sha256: sha256,
    p_size: size,
    p_modified_at: claim.modifiedAt === null ? null : new Date(claim.modifiedAt).toISOString(),
  });
  if (error === null) return { kind: "recorded" as const, ...RecordInstrumentFileRows.parse(data) };
  switch (error.code) {
    case "28000":
      return { kind: "refused" as const, answer: UNPAIRED };
    case "BL201":
      return { kind: "refused" as const, answer: { status: 413, body: { error: TOO_BIG } } };
    case "22023":
      return { kind: "refused" as const, answer: { status: 400, body: { error: error.message } } };
    default:
      throw new Error(`record_instrument_file: ${error.message} (${error.code ?? "no code"})`);
  }
}

// "Do you already have this?" The lab has it when its store holds these bytes, whether they
// came from this path, another instrument or an upload: then this path is recorded at once
// and nothing is sent. Only bytes the server verified are ever stored under their sha256.
export async function checkFile(session: InstrumentSession, claim: FileClaim, db: InstrumentDb): Promise<Answer> {
  if (claim.size > INSTRUMENT_MAX_BYTES) return { status: 413, body: { error: TOO_BIG } };
  // An empty file has no part to send, and its bytes need no verifying.
  if (claim.size === 0) {
    if (claim.sha256 !== EMPTY_SHA256) return { status: 422, body: { error: "An empty file has a different sha256." } };
    await putEmpty(uploadKey(session.labId, EMPTY_SHA256));
  } else if ((await objectSize(uploadKey(session.labId, claim.sha256))) !== claim.size) {
    return { status: 200, body: { have: false } };
  }
  const recorded = await record(session, claim, claim.sha256, claim.size, db);
  return recorded.kind === "refused" ? recorded.answer : { status: 200, body: { have: true } };
}

export async function startUpload(session: InstrumentSession, claim: FileClaim): Promise<Answer> {
  if (claim.size > INSTRUMENT_MAX_BYTES) return { status: 413, body: { error: TOO_BIG } };
  const staged = await startStaged(session.labId, "application/octet-stream");
  return { status: 200, body: { ...staged, partBytes: PART_BYTES, parts: partCount(claim.size) } };
}

const EMPTY_SHA256 = Sha256.parse(hashSecret(""));

async function putEmpty(key: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bl-empty-"));
  try {
    const path = join(dir, "empty");
    await writeFile(path, new Uint8Array());
    await putFile(key, { path, size: 0 }, "application/octet-stream");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const refusal = (r: Refused): Answer => ({ status: r.status, body: { error: r.error } });

export async function partUrl(
  session: InstrumentSession,
  staged: StagedSession,
  part: { partNumber: number; size: number },
): Promise<Answer> {
  if (part.size > INSTRUMENT_MAX_BYTES) return { status: 413, body: { error: TOO_BIG } };
  const target = await stagedPartUrl(session.labId, staged, part, `/api/instruments/uploads/${staged.uploadId}/parts/${part.partNumber}`);
  return "url" in target ? { status: 200, body: target } : refusal(target);
}

export async function receivePart(
  session: InstrumentSession,
  uploadId: string,
  partNumber: number,
  request: { headers: Headers; body: ReadableStream<Uint8Array> | null },
): Promise<Answer> {
  const received = await receiveStagedPart(session.labId, uploadId, partNumber, request);
  return "etag" in received ? { status: 200, body: null, headers: { etag: received.etag } } : refusal(received);
}

export async function completeUpload(
  session: InstrumentSession,
  uploadId: string,
  req: FileClaim & { storeId: string; parts: readonly PartRef[] },
  db: InstrumentDb,
): Promise<Answer> {
  const joined = await joinStaged(session.labId, uploadId, { ...req, maxBytes: INSTRUMENT_MAX_BYTES });
  switch (joined.kind) {
    case "too_large":
      return { status: 413, body: { error: TOO_BIG } };
    case "short":
      return { status: 409, body: { error: "Some parts of the file never arrived. Send it again." } };
    case "size_mismatch":
      return { status: 422, body: { error: "The file that arrived isn't the size it was said to be." } };
    case "joined":
      break;
    default: {
      const _exhaustive: never = joined;
      return _exhaustive;
    }
  }
  if (joined.sha256 !== req.sha256) {
    await discardStaged(session.labId, uploadId);
    return { status: 422, body: { error: "The file that arrived doesn't match its sha256." } };
  }
  await keepStaged(session.labId, uploadId, joined.sha256);
  // Throws on an unexpected database error, leaving the staged copy for a retry.
  const recorded = await record(session, req, joined.sha256, joined.size, db);
  await discardStaged(session.labId, uploadId);
  if (recorded.kind === "refused") return recorded.answer;
  return { status: recorded.duplicate ? 200 : 201, body: { locationId: recorded.locationId, duplicate: recorded.duplicate } };
}

export async function abortUpload(session: InstrumentSession, staged: StagedSession): Promise<Answer> {
  await abortStaged(session.labId, staged);
  return { status: 200, body: {} };
}
