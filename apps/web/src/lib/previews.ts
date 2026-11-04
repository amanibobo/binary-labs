import "server-only";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { previewEnv } from "@/env";

export type PreviewDelivery =
  | { kind: "redirect"; url: string }
  | { kind: "bytes"; body: Buffer; contentType: string }
  | { kind: "missing" };

const PRESIGN_SECONDS = 60;

// The worker writes local previews to <repo>/workers/.data/previews; the web app runs from apps/web.
const LOCAL_PREVIEW_ROOT = resolve(process.cwd(), "../../workers/.data/previews");

let s3: S3Client | undefined;

export async function deliverPreview(storageKey: string): Promise<PreviewDelivery> {
  const env = previewEnv();
  switch (env.PREVIEW_STORE) {
    case "r2": {
      s3 ??= new S3Client({
        region: "auto",
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
      });
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: storageKey }), {
        expiresIn: PRESIGN_SECONDS,
      });
      return { kind: "redirect", url };
    }
    case "local": {
      const path = resolve(join(LOCAL_PREVIEW_ROOT, storageKey));
      if (!path.startsWith(LOCAL_PREVIEW_ROOT + sep)) return { kind: "missing" };
      try {
        return { kind: "bytes", body: await readFile(path), contentType: "image/webp" };
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
