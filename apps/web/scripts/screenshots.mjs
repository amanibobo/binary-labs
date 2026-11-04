// Headless screenshots of the fixture pages. Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3100`.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const out = join(import.meta.dirname, "../screenshots");
mkdirSync(out, { recursive: true });

const results = "/dev/fixtures/search?state=results&q=p450%20gels";
const expandGel = (page) => page.getByRole("button", { name: "Details for Batch 3 SDS-PAGE gel" }).click();

const shots = [
  { name: "search-results", path: results, steps: expandGel, width: 1440, scheme: "light" },
  { name: "search-results", path: results, steps: expandGel, width: 1440, scheme: "dark" },
  { name: "search-results", path: results, width: 390, scheme: "light" },
  {
    name: "search-check",
    path: results,
    steps: (page) => page.getByRole("button", { name: "Check this label" }).click(),
    width: 390,
    scheme: "light",
  },
  {
    name: "search-check",
    path: results,
    steps: (page) => page.getByRole("button", { name: "Check this label" }).click(),
    width: 1440,
    scheme: "dark",
  },
  {
    name: "search-editor",
    path: results,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Batch 3 gel densitometry.*rename$/ }).click();
      await page.keyboard.type("Batch 3 densitometry, lanes 1 to 8");
    },
    width: 1440,
    scheme: "light",
  },
  {
    name: "search-tag-editor",
    path: results,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Experiment:? *P450 BM3$/ }).first().click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("P450");
      await page.keyboard.press("Enter");
    },
    width: 390,
    scheme: "light",
  },
  { name: "search-empty", path: "/dev/fixtures/search?state=empty", width: 1440, scheme: "light" },
  { name: "search-palette", path: "/dev/fixtures/search?state=empty", palette: "p450", width: 390, scheme: "light" },
  { name: "needs-a-look", path: "/dev/fixtures/needs-a-look", width: 390, scheme: "light" },
  { name: "needs-a-look", path: "/dev/fixtures/needs-a-look", width: 1440, scheme: "dark" },
  { name: "lab-settings", path: "/dev/fixtures/lab", width: 1440, scheme: "light" },
  { name: "lab-folder", path: "/dev/fixtures/folder", width: 1440, scheme: "light" },
];
const only = process.argv[2];

const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  for (const shot of shots) {
    const tag = `${shot.name}-${shot.width}-${shot.scheme}`;
    if (only !== undefined && !tag.includes(only)) continue;
    const context = await browser.newContext({
      viewport: { width: shot.width, height: shot.width < 500 ? 844 : 900 },
      colorScheme: shot.scheme,
      reducedMotion: "reduce",
      deviceScaleFactor: shot.width < 500 ? 2 : 1,
    });
    const page = await context.newPage();
    await page.goto(base + shot.path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    if (shot.steps) await shot.steps(page);
    if (shot.palette) {
      await page.keyboard.press("Meta+k");
      await page.getByPlaceholder("Search files").last().fill(shot.palette);
    }
    await page.waitForTimeout(400);
    const file = join(out, `${tag}.png`);
    await page.screenshot({ path: file, fullPage: !shot.palette });
    process.stdout.write(`${file}\n`);
    await context.close();
  }
} finally {
  await browser.close();
}
