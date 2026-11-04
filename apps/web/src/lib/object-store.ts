import "server-only";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { previewEnv } from "@/env";
import type { Delivery } from "./uploads";

// One store for previews (written by the worker) and uploaded files (written here): R2 in
// the pilot, a local folder in dev. Everything a lab has sits under <lab_id>/.

export type ObjectDelivery =
  | { kind: "redirect"; url: string }
  | { kind: "bytes"; body: Uint8Array<ArrayBuffer> }
  | { kind: "missing" };

const PRESIGN_SECONDS = 60;

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
    case "local": {
      const path = localPath(localRoot(env), key);
      if (path === null) throw new Error(`object key outside the store: ${key}`);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${randomUUID()}.tmp`;
      // The temp file may sit on another volume, so copy, then rename into place atomically.
      await copyFile(file.path, tmp);
      await rename(tmp, path).catch(async (err: unknown) => {
        await rm(tmp, { force: true });
        throw err;
      });
      return;
    }
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}

export async function deliverObject(key: string, delivery: Delivery): Promise<ObjectDelivery> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2": {
      const command = new GetObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
        ResponseContentType: delivery.contentType,
        ResponseContentDisposition: delivery.disposition,
      });
      return { kind: "redirect", url: await getSignedUrl(r2(env), command, { expiresIn: PRESIGN_SECONDS }) };
    }
    case "local": {
      const path = localPath(localRoot(env), key);
      if (path === null) return { kind: "missing" };
      // Dev and tests only; the pilot serves from R2 through a short-lived link.
      try {
        return { kind: "bytes", body: new Uint8Array(await readFile(path)) };
      } catch {
        return { kind: "missing" };
      }
    }
    default: {
      const _exhaustive: never = env;
      return _exhaustive;
    }
  }
}
