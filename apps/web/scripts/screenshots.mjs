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
  { name: "browse-root", path: "/dev/fixtures/browse", width: 1440, scheme: "dark" },
  { name: "browse-subfolder", path: "/dev/fixtures/browse?path=P450%2Fbatch3", steps: (page) => page.getByRole("button", { name: "Batch 3 yields.xlsx" }).click(), width: 1440, scheme: "dark" },
  { name: "browse-root", path: "/dev/fixtures/browse", width: 1440, scheme: "light" },
  { name: "browse-sheet", path: "/dev/fixtures/browse?path=P450", steps: (page) => page.getByRole("button", { name: "Menu" }).click(), full: false, width: 390, scheme: "dark" },
  { name: "search-results", path: results, steps: expandGel, width: 1440, scheme: "dark" },
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
    scheme: "dark",
  },
  { name: "needs-a-look", path: "/dev/fixtures/needs-a-look", width: 1440, scheme: "dark" },
  { name: "settings", path: "/dev/fixtures/lab", width: 1440, scheme: "dark" },
  { name: "sign-in", path: "/sign-in", width: 1440, scheme: "dark" },
  { name: "new-lab", path: "/dev/fixtures/new-lab", width: 1440, scheme: "dark" },
  { name: "lab-folder", path: "/dev/fixtures/folder", width: 1440, scheme: "dark" },
  { name: "search-palette", path: "/dev/fixtures/search?state=empty", palette: "p450", width: 1440, scheme: "dark" },
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
    await page.screenshot({ path: file, fullPage: !shot.palette && shot.full !== false });
    process.stdout.write(`${file}\n`);
    await context.close();
  }
} finally {
  await browser.close();
}
