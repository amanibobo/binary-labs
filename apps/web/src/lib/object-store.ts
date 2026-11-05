import "server-only";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { previewEnv } from "@/env";
import type { Delivery } from "./uploads";

// One store for previews (written by the worker) and uploaded files (written here): R2 in
// the pilot, a local folder in dev. Everything a lab has sits under <lab_id>/.

export type ObjectDelivery =
  // R2 answers the browser itself, ranges included, through a short-lived link.
  | { kind: "redirect"; url: string }
  // Dev and tests: the route streams the file, ranges included.
  | { kind: "file"; path: string; size: number }
  | { kind: "missing" };

const PRESIGN_SECONDS = 60;
// Long enough for one part on a slow connection, retries included.
const PART_PRESIGN_SECONDS = 15 * 60;

// The worker resolves PREVIEW_DIR from workers/ (default .data/previews); the web app runs from apps/web.
const WORKERS_DIR = resolve(process.cwd(), "../../workers");
const localRoot = (env: { PREVIEW_DIR?: string | undefined }) => resolve(WORKERS_DIR, env.PREVIEW_DIR ?? ".data/previews");

let s3: S3Client | undefined;

function r2(env: { R2_ACCOUNT_ID: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string }): S3Client {
  s3 ??= new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  return s3;
}

// Null when a key would step outside the root.
export function localPath(root: string, key: string): string | null {
  const path = resolve(join(root, key));
  return path.startsWith(root + sep) ? path : null;
}

function localKeyPath(env: { PREVIEW_DIR?: string | undefined }, key: string): string {
  const path = localPath(localRoot(env), key);
  if (path === null) throw new Error(`object key outside the store: ${key}`);
  return path;
}

// A multipart upload kept locally: each part is a file beside where the object will land.
const partsDir = (path: string) => `${path}.parts`;

// Moves a finished temp file to `path` atomically; the temp file may sit on another volume.
async function placeFile(from: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await copyFile(from, tmp);
  await rename(tmp, path).catch(async (err: unknown) => {
    await rm(tmp, { force: true });
    throw err;
  });
}

// Moves a finished temp file into the store. Same key, same bytes, so a repeat is harmless.
export async function putFile(key: string, file: { path: string; size: number }, contentType: string): Promise<void> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2": {
      await r2(env).send(
        new PutObjectCommand({
          Bucket: env.R2_BUCKET,
          Key: key,
          Body: createReadStream(file.path),
          ContentLength: file.size,
          ContentType: contentType,
        }),
      );
      return;
    }
    case "local":
      return placeFile(file.path, localKeyPath(env, key));
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

// A video element keeps asking for ranges of the URL it was redirected to, so a video's link
// has to outlast watching it; anything else gets a minute.
export async function deliverObject(key: string, delivery: Delivery, { expiresIn = PRESIGN_SECONDS } = {}): Promise<ObjectDelivery> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2": {
      const command = new GetObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        ResponseContentType: delivery.contentType,
        ResponseContentDisposition: delivery.disposition,
      });
      return { kind: "redirect", url: await getSignedUrl(r2(env), command, { expiresIn }) };
    }
    case "local": {
      const path = localPath(localRoot(env), key);
      if (path === null) return { kind: "missing" };
      const size = await localSize(path);
      return size === null ? { kind: "missing" } : { kind: "file", path, size };
    }
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

async function localSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

// Multipart uploads, for videos that go straight to the store. Locally the parts come through
// our own route and wait as files; in R2 the browser sends each part to a presigned URL.

export async function createMultipart(key: string, contentType: string, uploadId: string): Promise<string> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2": {
      const out = await r2(env).send(new CreateMultipartUploadCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: contentType }));
      if (out.UploadId === undefined) throw new Error("R2 started a multipart upload without an id");
      return out.UploadId;
    }
    case "local":
      await mkdir(partsDir(localKeyPath(env, key)), { recursive: true });
      return uploadId;
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

export type PartDestination = { kind: "presigned"; url: string } | { kind: "ours" };

// Where the browser sends part n. The signature pins the part's size, so a part can't be
// larger than the session allows.
export async function partDestination(key: string, storeId: string, partNumber: number, size: number): Promise<PartDestination> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2": {
      const command = new UploadPartCommand({ Bucket: env.R2_BUCKET, Key: key, UploadId: storeId, PartNumber: partNumber, ContentLength: size });
      const url = await getSignedUrl(r2(env), command, { expiresIn: PART_PRESIGN_SECONDS, signableHeaders: new Set(["content-length"]) });
      return { kind: "presigned", url };
    }
    case "local":
      return { kind: "ours" };
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

// Dev and tests only: a part that came through our route.
export async function putLocalPart(key: string, partNumber: number, file: { path: string }): Promise<void> {
  const env = previewEnv();
  if (env.PREVIEW_STORE !== "local") throw new Error("parts go straight to R2");
  await placeFile(file.path, join(partsDir(localKeyPath(env, key)), String(partNumber)));
}

export type PartRef = { partNumber: number; etag: string };

// Joins the parts into one object at `key`. Locally it also checks every part is there at the
// size the session gave it; R2 checks the parts against their ETags.
export async function completeMultipart(
  key: string,
  storeId: string,
  parts: readonly PartRef[],
  expected: { partBytes: number; size: number },
): Promise<"done" | "incomplete"> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2": {
      await r2(env).send(
        new CompleteMultipartUploadCommand({
          Bucket: env.R2_BUCKET,
          Key: key,
          UploadId: storeId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
      return "done";
    }
    case "local": {
      const path = localKeyPath(env, key);
      const dir = partsDir(path);
      const sizes = await Promise.all(parts.map((p) => localSize(join(dir, String(p.partNumber)))));
      const fits = sizes.every((size, i) => size === Math.min(expected.partBytes, expected.size - i * expected.partBytes));
      if (!fits) return "incomplete";
      const tmp = `${path}.${randomUUID()}.tmp`;
      const out = createWriteStream(tmp);
      try {
        for (const p of parts) {
          for await (const chunk of createReadStream(join(dir, String(p.partNumber)))) {
            if (!out.write(chunk)) await once(out, "drain");
          }
        }
        out.end();
        await finished(out);
        await rename(tmp, path);
      } catch (err) {
        out.destroy();
        await rm(tmp, { force: true });
        throw err;
      }
      // The parts stay until the upload is recorded, so a retried complete can join them again.
      return "done";
    }
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

export async function abortMultipart(key: string, storeId: string): Promise<void> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2":
      await r2(env).send(new AbortMultipartUploadCommand({ Bucket: env.R2_BUCKET, Key: key, UploadId: storeId }));
      return;
    case "local": {
      const path = localKeyPath(env, key);
      await rm(partsDir(path), { recursive: true, force: true });
      return;
    }
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

export async function objectSize(key: string): Promise<number | null> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2":
      try {
        const head = await r2(env).send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
        return head.ContentLength ?? null;
      } catch (err) {
        if (err instanceof NotFound) return null;
        throw err;
      }
    case "local":
      return localSize(localKeyPath(env, key));
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

// The object's bytes as a stream, to hash them on the server.
export async function readObject(key: string): Promise<AsyncIterable<Uint8Array>> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2": {
      const out = await r2(env).send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
      // On Node the SDK hands back the response itself, a Readable.
      if (!(out.Body instanceof Readable)) throw new Error(`no readable body for ${key}`);
      return out.Body;
    }
    case "local":
      return createReadStream(localKeyPath(env, key));
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

// Copies the object at `from` to `to`, unless the same bytes are already there.
export async function copyObject(from: string, to: string): Promise<void> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2":
      if ((await objectSize(to)) === null) {
        await r2(env).send(new CopyObjectCommand({ Bucket: env.R2_BUCKET, CopySource: `${env.R2_BUCKET}/${from}`, Key: to }));
      }
      return;
    case "local":
      return placeFile(localKeyPath(env, from), localKeyPath(env, to));
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

// Removes what an upload left at its staging key: the joined object, and locally its parts.
export async function discardStaging(key: string): Promise<void> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2":
      await r2(env).send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
      return;
    case "local": {
      const path = localKeyPath(env, key);
      await rm(partsDir(path), { recursive: true, force: true });
      await rm(path, { force: true });
      return;
    }
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}
