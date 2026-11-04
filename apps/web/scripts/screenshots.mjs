// Headless screenshots of the fixture pages. Needs `BINARY_LABS_FIXTURES=1 pnpm dev` on port 3100.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const out = join(import.meta.dirname, "../screenshots");
mkdirSync(out, { recursive: true });

const pages = [
  { name: "sign-in", path: "/sign-in" },
  { name: "create-lab", path: "/dev/fixtures/new-lab" },
  { name: "search-empty", path: "/dev/fixtures/search?state=empty" },
  { name: "search-results", path: "/dev/fixtures/search?state=results&q=p450%20gels", expand: true },
  { name: "search-keyword", path: "/dev/fixtures/search?state=keyword&q=p450%20gels" },
  { name: "search-scanning", path: "/dev/fixtures/search?state=scanning" },
  { name: "search-new-lab", path: "/dev/fixtures/search?state=new" },
  { name: "search-palette", path: "/dev/fixtures/search?state=empty", palette: "p450" },
  { name: "lab-connect", path: "/dev/fixtures/lab?state=connect" },
  { name: "lab-scanning", path: "/dev/fixtures/lab?state=scanning" },
  { name: "lab-folder", path: "/dev/fixtures/folder" },
];
const viewports = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const only = process.argv[2];

const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  for (const scheme of ["light", "dark"]) {
    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: scheme,
        reducedMotion: "reduce",
        deviceScaleFactor: vp.width < 500 ? 2 : 1,
      });
      const page = await context.newPage();
      for (const p of pages) {
        if (only !== undefined && !p.name.includes(only)) continue;
        await page.goto(base + p.path, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        if (p.expand) {
          await page.getByRole("button", { expanded: false }).nth(1).click();
        }
        if (p.palette) {
          await page.keyboard.press("Meta+k");
          await page.getByPlaceholder("Search files").last().fill(p.palette);
        }
        await page.waitForTimeout(400);
        const file = join(out, `${p.name}-${vp.name}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: !p.palette });
        process.stdout.write(`${file}\n`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
