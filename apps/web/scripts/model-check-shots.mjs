import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

// Headless screenshots of the model check's fixture page, and one click through it: judging
// an answer, then keeping the task. Needs `BINARY_LABS_FIXTURES=1 next dev` on BASE_URL.
//   node scripts/model-check-shots.mjs <out dir>

const base = process.env.BASE_URL ?? "http://localhost:3117";
const out = process.argv[2] ?? "screenshots/model-check";
mkdirSync(out, { recursive: true });

const shots = [
  ...["checked", "settled", "ready", "unset"].flatMap((view) => [1280, 390].map((width) => ({ view, width, scheme: "light" }))),
  { view: "checked", width: 1280, scheme: "dark" },
  { view: "kept", width: 1280, scheme: "light" },
  { view: "runner", width: 1280, scheme: "light" },
  { view: "checking", width: 1280, scheme: "light" },
  { view: "notask", width: 390, scheme: "light" },
];

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }) });
const failures = [];
try {
  for (const shot of shots) {
    const context = await browser.newContext({ viewport: { width: shot.width, height: 900 }, colorScheme: shot.scheme, reducedMotion: "reduce", deviceScaleFactor: shot.width < 500 ? 2 : 1 });
    const page = await context.newPage();
    page.on("pageerror", (e) => failures.push(`${shot.view}: ${e.message}`));
    await page.goto(`${base}/dev/fixtures/model-check?view=${shot.view}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Model check" }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) failures.push(`${shot.view} ${shot.width}: the page scrolls sideways`);
    await page.screenshot({ path: `${out}/model-check-${shot.view}-${shot.width}-${shot.scheme}.png`, fullPage: true });
    await context.close();
  }

  // A second scientist judges the partial answer, then keeps the task most models failed.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/dev/fixtures/model-check?view=checked`, { waitUntil: "networkidle" });
  const before = await page.getByText(/^Solved by \d of \d models$/).textContent();
  await page.getByRole("textbox").fill("Two causes is not an answer.");
  await page.getByRole("button", { name: "It didn't" }).click();
  await page.getByRole("button", { name: "Keep this task" }).waitFor();
  const after = await page.getByText(/^Solved by \d of \d models$/).textContent();
  await page.getByRole("button", { name: "Keep this task" }).click();
  await page.getByText(/^Kept by You/).waitFor();
  await page.screenshot({ path: `${out}/model-check-judged-kept-1280-light.png`, fullPage: true });
  process.stdout.write(`before: ${before}\nafter judging: ${after}\n`);
  await context.close();
} finally {
  await browser.close();
}
if (failures.length > 0) {
  process.stdout.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`${shots.length + 1} screenshots in ${out}\n`);
