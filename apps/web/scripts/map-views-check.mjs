// The lab map's remembered view, headless, on the fixture lab: turn tags on, open a hub from
// the search box, zoom and pan, and check what the map saved; then open the map with that save
// and check it comes back as it was left, without saving again. Screenshots go to OUT.
// Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3100` (or BASE_URL).
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const out = process.env.OUT ?? "/tmp";
const assert = (ok, what) => {
  if (!ok) throw new Error(`failed: ${what}`);
  console.log(`ok: ${what}`);
};

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/dev/fixtures/map?view=default`, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    window.__saves = [];
    window.addEventListener("fixture-map-save", (e) => window.__saves.push(e.detail));
  });
  await page.getByRole("switch", { name: "Tags" }).click();
  await page.waitForFunction(() => !document.body.textContent?.includes("Loading…"));
  const search = page.getByRole("combobox", { name: "Find on the map" });
  await search.fill("P450 batch 3");
  await search.press("Enter");
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !document.body.textContent?.includes("Loading…"));
  const box = await page.locator("canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
  // Drag from an empty corner, so the drag pans instead of moving a dot.
  await page.mouse.move(box.x + 20, box.y + box.height - 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + box.height - 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(6000);
  const saves = await page.evaluate(() => window.__saves);
  const last = saves.at(-1);
  console.log(`${saves.length} saves, last: ${JSON.stringify(last)}`);
  assert(saves.length >= 1 && saves.length <= 4, "saves come a moment after changes, not on every frame");
  assert(last?.tags === true && last?.similar === false, "the switches are saved");
  assert(last?.place?.open?.some((id) => id.startsWith("experiment:")), "the opened hub is saved");
  assert(last?.place?.camera !== null && last.place.camera.k > 1, "the zoomed-in camera is saved");
  await page.screenshot({ path: `${out}/map-left.png` });

  const back = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await back.goto(`${base}/dev/fixtures/map?view=default&saved=${encodeURIComponent(JSON.stringify(last))}`, { waitUntil: "networkidle" });
  await back.evaluate(() => {
    window.__saves = [];
    window.addEventListener("fixture-map-save", (e) => window.__saves.push(e.detail));
  });
  await back.waitForFunction(() => !document.body.textContent?.includes("Loading…"));
  await back.waitForTimeout(6000);
  assert((await back.getByRole("switch", { name: "Tags" }).getAttribute("aria-checked")) === "true", "tags come back on");
  const shown = await back.evaluate(() => document.querySelector("[aria-label='Show on the map'] .sr-only")?.textContent ?? "");
  console.log(`restored: ${shown}`);
  assert(/files/.test(shown) && /tags/.test(shown), "the opened hub's files and the tags are drawn again");
  assert((await back.evaluate(() => window.__saves.length)) === 0, "opening a remembered view saves nothing");
  await back.screenshot({ path: `${out}/map-back.png` });
} finally {
  await browser.close();
}
