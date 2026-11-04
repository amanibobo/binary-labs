import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const url = process.env.LANDING_URL ?? "http://localhost:3200";
const outDir = new URL("../screenshots/", import.meta.url);
const widths = [1440, 390];
const expectedGround = { light: "rgb(247, 248, 246)", dark: "rgb(15, 30, 33)" };

await mkdir(outDir, { recursive: true });
// The full Chromium build in new headless mode, so no separate headless-shell download is needed.
const browser = await chromium.launch({ headless: true, channel: "chromium" });

for (const width of widths) {
  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width, height: width > 600 ? 900 : 844 },
      deviceScaleFactor: 2,
      colorScheme,
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (ground !== expectedGround[colorScheme]) {
      throw new Error(`${width}px ${colorScheme}: stylesheet missing or stale, body background is ${ground}`);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0) throw new Error(`${width}px ${colorScheme}: horizontal overflow of ${overflow}px`);
    const path = new URL(`landing-${width}-${colorScheme}.png`, outDir).pathname;
    await page.screenshot({ path, fullPage: true });
    console.log(`saved ${path}`);
    await page.close();
  }
}

await browser.close();
