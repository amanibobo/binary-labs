// The R2 bucket settings the browser upload paths need (docs/deploy.md, "R2 bucket"):
//
// - CORS: the app's pages PUT files and video parts straight to presigned R2 URLs, so the
//   bucket has to allow PUT from the app's origin, accept the signed content-type header, and
//   expose ETag (the video uploader reads each part's ETag to complete the upload).
// - Lifecycle: abandoned multipart uploads are aborted after a day. The server keeps no list
//   of open sessions, and parts aren't objects a listing finds.
//
// Prints the settings by default and sends nothing. --apply writes them to the bucket, which
// replaces the bucket's existing CORS and lifecycle rules; it prints what was there first.
//
//   node scripts/r2-bucket.mjs https://app.example.com [more origins...]
//   R2_ACCOUNT_ID=... R2_ADMIN_ACCESS_KEY_ID=... R2_ADMIN_SECRET_ACCESS_KEY=... R2_BUCKET=... \
//     node scripts/r2-bucket.mjs --apply https://app.example.com
//
// --apply needs an R2 token with Admin Read & Write: the app's Object Read & Write token can't
// change bucket settings. The dashboard takes the same CORS JSON (bucket > Settings > CORS policy).

import {
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const say = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const origins = args.filter((a) => a !== "--apply");

if (origins.length === 0) {
  console.error("Name the app's origins, e.g. https://app.example.com (and http://localhost:3000 for dev against R2).");
  process.exit(2);
}
for (const origin of origins) {
  const url = URL.canParse(origin) ? new URL(origin) : null;
  if (url === null || url.origin !== origin || !["https:", "http:"].includes(url.protocol)) {
    console.error(`${origin} isn't an origin: scheme and host only, no path or trailing slash.`);
    process.exit(2);
  }
  if (url.protocol === "http:" && url.hostname !== "localhost") {
    console.error(`${origin}: only localhost may be plain http.`);
    process.exit(2);
  }
}

const cors = {
  CORSRules: [
    {
      AllowedOrigins: origins,
      AllowedMethods: ["PUT", "GET", "HEAD"],
      AllowedHeaders: ["content-type"],
      ExposeHeaders: ["ETag"],
      MaxAgeSeconds: 3600,
    },
  ],
};

const lifecycle = {
  Rules: [
    {
      ID: "abort-incomplete-multipart-uploads",
      Status: "Enabled",
      Filter: { Prefix: "" },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
  ],
};

say("CORS (the dashboard's CORS policy takes this array):");
say(JSON.stringify(cors.CORSRules, null, 2));
say("\nLifecycle:");
say(JSON.stringify(lifecycle.Rules, null, 2));

if (!apply) {
  say("\nNothing sent. Run again with --apply to write these to the bucket.");
  process.exit(0);
}

const env = Object.fromEntries(
  ["R2_ACCOUNT_ID", "R2_ADMIN_ACCESS_KEY_ID", "R2_ADMIN_SECRET_ACCESS_KEY", "R2_BUCKET"].map((name) => [name, process.env[name]?.trim()]),
);
const missing = Object.entries(env)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length > 0) {
  console.error(`\nMissing: ${missing.join(", ")}`);
  process.exit(2);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ADMIN_ACCESS_KEY_ID, secretAccessKey: env.R2_ADMIN_SECRET_ACCESS_KEY },
});
const Bucket = env.R2_BUCKET;

async function current(command, pick) {
  try {
    return pick(await s3.send(command));
  } catch (err) {
    return `none (${err.name})`;
  }
}

say(`\nBucket ${Bucket} had:`);
say("CORS:", JSON.stringify(await current(new GetBucketCorsCommand({ Bucket }), (r) => r.CORSRules)));
say("Lifecycle:", JSON.stringify(await current(new GetBucketLifecycleConfigurationCommand({ Bucket }), (r) => r.Rules)));
await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: cors }));
await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: lifecycle }));
say(`\nWrote CORS and lifecycle to ${Bucket}.`);
