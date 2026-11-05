import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { fileResponse } from "@/lib/serve-file";

// The fixture video and its poster, served with ranges like /api/files is, for the video
// screenshots. Dev only: *.dev.tsx files aren't routes in a production build.
const MEDIA = {
  "bench.webm": "video/webm",
  "bench-poster.webp": "image/webp",
} as const;

function isMedia(name: string): name is keyof typeof MEDIA {
  return Object.hasOwn(MEDIA, name);
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (process.env.BINARY_LABS_FIXTURES !== "1" || !isMedia(name)) return new Response(null, { status: 404 });
  const path = join(process.cwd(), "src/fixtures/media", name);
  const { size } = await stat(path);
  return fileResponse({ path, size, range: request.headers.get("range"), headers: { "content-type": MEDIA[name] } });
}
