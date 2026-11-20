// A demo lab's data is made up, so the app marks it Sample (decisions.md, "Sample on demo data").
// Downloads every chart export from the fixture lab (which is a demo lab) and checks each one says
// so, then screenshots the mark. Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3100`;
// OUT=<dir> for the screenshots.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const out = process.env.OUT ?? join(import.meta.dirname, "../screenshots/sample");
mkdirSync(out, { recursive: true });
const MARK = "Sample data";

const browser = await chromium.launch({ headless: true, channel: "chromium" });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

async function ready(page, path) {
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForFunction(() => {
    const button = document.querySelector("main button");
    return button !== null && Object.keys(button).some((k) => k.startsWith("__reactProps"));
  });
}

async function download(page, item) {
  await page.getByRole("button", { name: "Download" }).first().click();
  const pending = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: item }).click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();

for (const [path, label] of [
  ["/dev/fixtures/charts?view=saved", "a chart"],
  ["/dev/fixtures/runs?view=bradford", "a run history"],
]) {
  await ready(page, path);
  for (const [item, ext] of [
    [/^PDF/, "pdf"],
    [/^SVG/, "svg"],
    [/^PNG picture/, "png"],
    [/^The numbers behind it/, "csv"],
  ]) {
    const file = await download(page, item);
    check(file.name.startsWith(MARK) && file.name.endsWith(`.${ext}`), `${label} as ${ext} is named ${file.name}`);
    if (ext === "png") continue;
    const text = file.bytes.toString("latin1");
    check(ext === "csv" ? text.split(/\r?\n/)[0].includes(MARK) : text.includes(MARK), `${label} as ${ext} says ${MARK} inside`);
  }
}

await ready(page, "/dev/fixtures/charts?view=bradford-plate");
await page.getByRole("button", { name: /^How two measurements relate/ }).click();
await page.getByText("Your samples, read off the line").waitFor();
const pending = page.waitForEvent("download");
await page.getByRole("button", { name: "Download as CSV" }).click();
const samples = await pending;
const samplesText = readFileSync(await samples.path(), "utf8");
check(samples.suggestedFilename().startsWith(MARK) && samplesText.split(/\r?\n/)[0].includes(MARK), `the samples table as csv: ${samples.suggestedFilename()}`);
await context.close();

const shots = [
  { name: "sidebar", path: "/dev/fixtures/browse", width: 1440 },
  { name: "sidebar-collapsed", path: "/dev/fixtures/browse", width: 1440, collapsed: true },
  { name: "phone-bar", path: "/dev/fixtures/browse", width: 390 },
  // The menu sheet names the lab over the bar, which keeps its own mark.
  { name: "phone-menu", path: "/dev/fixtures/browse", width: 390, marks: 2, steps: (p) => p.getByRole("button", { name: "Menu" }).click() },
];
for (const shot of shots) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: shot.width, height: shot.width > 600 ? 900 : 844 }, colorScheme: scheme, deviceScaleFactor: 2 });
    if (shot.collapsed) await ctx.addCookies([{ name: "bl-sidebar", value: "collapsed", url: base }]);
    const p = await ctx.newPage();
    await p.goto(base + shot.path, { waitUntil: "networkidle" });
    if (shot.steps) await shot.steps(p);
    await p.waitForTimeout(400);
    const marks = await p.getByText("Sample", { exact: true }).evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).length);
    check(marks === (shot.marks ?? 1), `${shot.name} ${scheme}: ${marks} Sample marks on screen`);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `${shot.name} ${scheme}: no sideways scroll`);
    await p.screenshot({ path: join(out, `${shot.name}-${shot.width}-${scheme}.png`), clip: { x: 0, y: 0, width: Math.min(shot.width, 480), height: shot.width > 600 ? 200 : 140 } });
    await ctx.close();
  }
}

await browser.close();
if (failures.length > 0) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
