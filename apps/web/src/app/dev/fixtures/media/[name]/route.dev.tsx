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

// The handwritten notebook pages of the HeLa drug A note, "note-page-07.webp".
const NOTE_PAGE = /^note-page-(\d{2})\.webp$/;

function isMedia(name: string): name is keyof typeof MEDIA {
  return Object.hasOwn(MEDIA, name);
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (process.env.BINARY_LABS_FIXTURES !== "1") return new Response(null, { status: 404 });
  const page = NOTE_PAGE.exec(name);
  if (page !== null) {
    const notePath = join(process.cwd(), "src/fixtures/media/notes", `page_${page[1]}.webp`);
    const found = await stat(notePath).catch(() => null);
    if (found === null) return new Response(null, { status: 404 });
    return fileResponse({ path: notePath, size: found.size, range: request.headers.get("range"), headers: { "content-type": "image/webp" } });
  }
  if (!isMedia(name)) return new Response(null, { status: 404 });
  const path = join(process.cwd(), "src/fixtures/media", name);
  const { size } = await stat(path);
  return fileResponse({ path, size, range: request.headers.get("range"), headers: { "content-type": MEDIA[name] } });
}
