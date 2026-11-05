// Records the onboarding clips from the fixture app, headless, in both themes, and encodes each
// to MP4 (H.264) and WebM (VP9) with a WebP poster under public/onboarding/. Also rewrites
// src/components/onboarding/clip-sizes.ts. Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3103`
// and ffmpeg and cwebp. Raw recordings go to CLIP_RAW_DIR and are deleted once encoded.
//   node scripts/record-clips.mjs [clip-id-or-scheme-filter]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3103";
const ffmpeg = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ffprobe = process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe";
const cwebp = process.env.CWEBP ?? "/opt/homebrew/bin/cwebp";
const rawDir = process.env.CLIP_RAW_DIR;
if (rawDir === undefined) throw new Error("set CLIP_RAW_DIR to a scratch folder for the raw recordings");
const out = join(import.meta.dirname, "../public/onboarding");
const sizesFile = join(import.meta.dirname, "../src/components/onboarding/clip-sizes.ts");
mkdirSync(out, { recursive: true });
mkdirSync(rawDir, { recursive: true });
const MAX_WIDTH = 720;
const benchClip = readFileSync(join(import.meta.dirname, "../src/fixtures/media/bench.webm"));
const paddedClip = Buffer.concat([benchClip, Buffer.alloc(20 * 1024 * 1024 - benchClip.length)]);

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

// A visible pointer, since recordings don't show the real one; a soft dot marks each press.
const CURSOR = `
addEventListener("DOMContentLoaded", () => {
  const c = document.createElement("div");
  c.id = "rec-cursor";
  c.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-2px 0 0 -2px;z-index:2147483647;pointer-events:none;transition:transform 90ms ease-out;opacity:0";
  c.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1.5v13l3.6-3.3 2.6 5.3 2.2-1-2.5-5.2h4.9z" fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  addEventListener("mousemove", (e) => { c.style.opacity = "1"; c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", () => { c.style.transform = "scale(0.85)"; }, true);
  addEventListener("mouseup", () => { c.style.transform = ""; }, true);
});`;

async function pointAt(page, locator, { steps = 22 } = {}) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`nothing to point at: ${locator}`);
  await page.mouse.move(box.x + Math.min(box.width / 2, 40), box.y + box.height / 2, { steps });
  await page.waitForTimeout(180);
}

async function clickAt(page, locator) {
  await pointAt(page, locator);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
}

const box = async (locator) => {
  const b = await locator.boundingBox();
  if (b === null) throw new Error(`no box for ${locator}`);
  return b;
};

// Fixture labels arrive a moment after the results and make rows taller, so framing waits.
const settled = (page) => page.waitForTimeout(1500);

// The main column, from a point above the given element, so each clip frames one task.
async function column(page, anchor, { above, height }) {
  const main = await box(page.locator("main"));
  const a = await box(anchor);
  const width = Math.min(860, main.width);
  return { x: main.x + (main.width - width) / 2, y: Math.max(0, a.y - above), width, height };
}

const CLIPS = [
  {
    id: "search",
    path: "/dev/fixtures/search?state=results",
    crop: (page) => column(page, page.getByRole("searchbox"), { above: 40, height: 520 }),
    async run(page) {
      await clickAt(page, page.getByRole("searchbox"));
      await page.keyboard.type("p450 gels", { delay: 110 });
      await page.getByRole("heading", { name: /\d+ (files|results)/ }).waitFor();
      await page.waitForTimeout(1800);
    },
  },
  {
    id: "open",
    path: "/dev/fixtures/search?state=results&q=p450%20gels",
    async crop(page) {
      await settled(page);
      return column(page, page.getByRole("button", { name: "Details for Batch 3 SDS-PAGE gel" }), { above: 24, height: 520 });
    },
    async run(page) {
      await clickAt(page, page.getByRole("button", { name: "Details for Batch 3 SDS-PAGE gel" }));
      await page.waitForTimeout(900);
      await pointAt(page, page.getByRole("link", { name: /Open in Dropbox/ }).first());
      await page.waitForTimeout(1500);
    },
  },
  {
    id: "fix",
    path: "/dev/fixtures/search?state=results&q=p450%20gels",
    async crop(page) {
      await settled(page);
      const name = page.getByRole("button", { name: /^Batch 3 gel densitometry.*rename$/ });
      await name.evaluate((el) => el.scrollIntoView({ block: "center" }));
      return column(page, name, { above: 160, height: 400 });
    },
    async run(page) {
      await clickAt(page, page.getByRole("button", { name: /^Batch 3 gel densitometry.*rename$/ }));
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Batch 3 densitometry, lanes 1 to 8", { delay: 55 });
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1600);
    },
  },
  {
    id: "needs-look",
    path: "/dev/fixtures/needs-a-look",
    crop: (page) => column(page, page.getByRole("heading", { name: "Needs a look" }), { above: 40, height: 480 }),
    async run(page) {
      const field = page.getByPlaceholder("What is this?").first();
      await page.waitForTimeout(400);
      await clickAt(page, field);
      await page.keyboard.type("Plate reader export, Nov 3", { delay: 60 });
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1700);
    },
  },
  {
    id: "upload",
    path: "/dev/fixtures/upload",
    viewport: PHONE,
    phone: true,
    // From the two buttons down, so the new upload's row and its label are in frame.
    async crop(page) {
      const take = await box(page.getByText("Take a photo"));
      const y = Math.max(0, take.y - 28);
      return { x: 0, y, width: PHONE.width, height: Math.min(460, PHONE.height - y) };
    },
    async run(page, { gelPng }) {
      await page.waitForTimeout(700);
      await page.locator('input[type="file"][multiple]').setInputFiles({ name: "Gel batch 5.png", mimeType: "image/png", buffer: gelPng });
      await page.getByText("Batch 5 SDS-PAGE gel").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(1500);
    },
  },
  {
    id: "talk-through",
    path: "/dev/fixtures/talk-throughs?view=record",
    crop: (page) => column(page, page.getByRole("heading", { name: "Record a talk-through" }), { above: 40, height: 480 }),
    async run(page) {
      await clickAt(page, page.getByRole("button", { name: "Start recording" }));
      await page.getByText("Recording", { exact: true }).waitFor();
      await page.waitForTimeout(2600);
      await clickAt(page, page.getByRole("button", { name: "Stop" }));
      await page.getByRole("button", { name: "Write up the steps" }).waitFor();
      await page.waitForTimeout(1200);
    },
  },
  {
    id: "video",
    path: "/dev/fixtures/protocols?view=no-videos",
    // The dialog is centered on the whole screen and the upload shows under the Videos heading,
    // so this one frames the page beside the sidebar with the heading near the top.
    async crop(page) {
      const heading = await box(page.getByRole("heading", { name: "Videos" }));
      await page.evaluate((y) => window.scrollBy(0, y), heading.y - 120);
      await page.waitForTimeout(200);
      const main = await box(page.locator("main"));
      return { x: main.x, y: 0, width: main.width, height: DESKTOP.height };
    },
    async run(page) {
      await clickAt(page, page.getByRole("button", { name: "Add a video" }));
      await page.waitForTimeout(600);
      await pointAt(page, page.getByText("Choose a video"));
      await page.waitForTimeout(300);
      // Three 8 MB parts; a file named "…column…" holds at half way in the fixture (src/fixtures/videos.ts).
      await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "Loading the nickel column.webm", mimeType: "video/webm", buffer: paddedClip });
      await page.getByText(/Uploading, \d+%/).waitFor();
      await page.waitForTimeout(1800);
    },
  },
  {
    id: "chart",
    path: "/dev/fixtures/charts?view=new",
    async crop(page) {
      const main = await box(page.locator("main"));
      return { x: main.x + 16, y: 64, width: main.width - 24, height: 560 };
    },
    async run(page) {
      await page.waitForTimeout(400);
      await clickAt(page, page.getByRole("checkbox", { name: /A2/ }));
      await page.waitForTimeout(500);
      await clickAt(page, page.getByRole("checkbox", { name: /A3/ }));
      await page.waitForTimeout(600);
      await clickAt(page, page.getByPlaceholder("Chart title"));
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Plate 7, wells A1 to A3", { delay: 50 });
      await page.waitForTimeout(1500);
    },
  },
  {
    id: "settings",
    path: "/dev/fixtures/lab",
    crop: (page) => column(page, page.getByRole("heading", { level: 1 }).first(), { above: 40, height: 520 }),
    async run(page) {
      await page.waitForTimeout(500);
      // Tiles link to the real Settings routes, so the clip points at them rather than opening one.
      await pointAt(page, page.getByRole("link", { name: /^Dropbox/ }).first());
      await page.waitForTimeout(1100);
      await pointAt(page, page.getByRole("link", { name: /^Members/ }).first());
      await page.waitForTimeout(1500);
    },
  },
];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function encode({ raw, name, crop, start, end }) {
  const c = { w: even(crop.width), h: even(crop.height), x: even(crop.x), y: even(crop.y) };
  const scale = Math.min(1, MAX_WIDTH / c.w);
  const size = { width: even(c.w * scale), height: even(c.h * scale) };
  const filter = `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${size.width}:${size.height}:flags=lanczos,fps=24`;
  const span = ["-ss", start.toFixed(2), "-to", end.toFixed(2)];
  const run = (args) => execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", raw, ...args], { stdio: "inherit" });
  run([...span, "-vf", filter, "-an", "-c:v", "libx264", "-preset", "veryslow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(out, `${name}.mp4`)]);
  run([...span, "-vf", filter, "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", join(out, `${name}.webm`)]);
  // This ffmpeg has no WebP encoder, so the poster goes through a PNG and cwebp.
  const png = join(rawDir, `${name}.png`);
  run(["-ss", (end - 0.15).toFixed(2), "-vf", filter, "-frames:v", "1", png]);
  execFileSync(cwebp, ["-quiet", "-q", "82", png, "-o", join(out, `${name}.webp`)]);
  rmSync(png);
  return size;
}

// The same gel photo the screenshots use, for the upload clip.
async function drawGel(browser) {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  const lanes = Array.from({ length: 8 }, (_, i) =>
    [96, 150, 205].map((y, j) => `<rect x="${36 + i * 54}" y="${y + (i % 3) * 5}" width="40" height="7" rx="3" fill="#e9eee8" opacity="${0.9 - j * 0.22}"/>`).join(""),
  ).join("");
  await page.setContent(`<body style="margin:0"><svg width="480" height="320"><rect width="480" height="320" fill="#1d2326"/>${lanes}</svg></body>`);
  const png = await page.screenshot();
  await page.close();
  return png;
}

const only = process.argv[2];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const sizes = {};
try {
  const gelPng = await drawGel(browser);
  for (const clip of CLIPS) {
    for (const scheme of ["dark", "light"]) {
      const name = `${clip.id}-${scheme}`;
      if (only !== undefined && !name.includes(only)) continue;
      const viewport = clip.viewport ?? DESKTOP;
      const context = await browser.newContext({
        viewport,
        colorScheme: scheme,
        deviceScaleFactor: 1,
        permissions: ["microphone"],
        recordVideo: { dir: rawDir, size: viewport },
        ...(clip.phone ? { hasTouch: true, isMobile: true } : {}),
      });
      await context.addInitScript(CURSOR);
      const page = await context.newPage();
      await page.goto(base + clip.path, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const crop = await clip.crop(page);
      const startedAt = Date.now();
      await clip.run(page, { gelPng });
      const endedAt = Date.now();
      const video = page.video();
      await context.close();
      const raw = await video.path();
      // The recording starts a beat after the page does, so time is counted back from its end.
      const length = Number(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", raw]).toString());
      const start = Math.max(0, length - (endedAt - startedAt) / 1000 - 0.25);
      const end = length - 0.1;
      sizes[clip.id] = encode({ raw, name, crop, start, end });
      rmSync(raw);
      const kb = (f) => Math.round(statSync(join(out, f)).size / 1024);
      process.stdout.write(`${name}: ${(end - start).toFixed(1)} s, ${kb(`${name}.mp4`)} KB mp4, ${kb(`${name}.webm`)} KB webm, ${kb(`${name}.webp`)} KB poster\n`);
    }
  }
} finally {
  await browser.close();
}

if (only === undefined) {
  const lines = Object.entries(sizes).map(([id, s]) => `  ${JSON.stringify(id)}: { width: ${s.width}, height: ${s.height} },`);
  writeFileSync(
    sizesFile,
    `// Written by scripts/record-clips.mjs; rerun it rather than editing by hand.\nimport type { ClipId } from "@/lib/onboarding";\n\nexport const CLIP_SIZES = {\n${lines.join("\n")}\n} as const satisfies Record<ClipId, { width: number; height: number }>;\n`,
  );
}
