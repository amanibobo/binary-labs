// Frame times of the lab map on the pilot-sized fixture lab (20,000 files), headless.
// Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3100` (or BASE_URL).
// For each view: how long the layout takes to come to rest, frame intervals while it settles,
// and frame intervals while someone pans and zooms the settled map.
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const views = [
  { name: "hubs", path: "/dev/fixtures/map?size=pilot&view=default" },
  { name: "one hub open (biggest experiment)", path: "/dev/fixtures/map?size=pilot&view=expanded" },
  { name: "two hubs open, similar in meaning on", path: "/dev/fixtures/map?size=pilot&view=similar" },
  { name: "every hub open", path: "/dev/fixtures/map?size=pilot&view=default&open=all" },
];

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))].toFixed(1);
};

// Records requestAnimationFrame intervals until stopped.
const startFrames = (page) =>
  page.evaluate(() => {
    window.__frames = [];
    window.__stop = false;
    let last = performance.now();
    const step = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (!window.__stop) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
const stopFrames = (page) => page.evaluate(() => ((window.__stop = true), window.__frames.slice(1)));

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }) });
try {
  for (const v of views) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(base + v.path, { waitUntil: "networkidle", timeout: 120_000 });
    // Settling: the map ticks every frame until its layout rests (or 20 s).
    await startFrames(page);
    const t0 = Date.now();
    await page.waitForFunction(() => !document.body.textContent?.includes("Loading…"), null, { timeout: 120_000 });
    await page.waitForTimeout(8000);
    const settle = await stopFrames(page);
    const dots = await page.evaluate(() => document.querySelector("[aria-label='Show on the map'] .sr-only")?.textContent ?? "");
    // Panning and zooming the settled map.
    const box = await page.locator("canvas").boundingBox();
    await startFrames(page);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, i < 15 ? -60 : 60);
    await page.mouse.move(cx - 200, cy - 100);
    await page.mouse.down();
    for (let i = 0; i < 40; i++) await page.mouse.move(cx - 200 + i * 8, cy - 100 + i * 4);
    await page.mouse.up();
    const pan = await stopFrames(page);
    const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    process.stdout.write(
      JSON.stringify({
        view: v.name,
        shown: dots,
        settleFrames: settle.length,
        settleP50: q(settle, 0.5),
        settleP95: q(settle, 0.95),
        panFrames: pan.length,
        panP50: q(pan, 0.5),
        panP95: q(pan, 0.95),
        heapMB: +(heap / 1e6).toFixed(0),
        wallS: (Date.now() - t0) / 1000,
      }) + "\n",
    );
    await page.close();
  }
} finally {
  await browser.close();
}
