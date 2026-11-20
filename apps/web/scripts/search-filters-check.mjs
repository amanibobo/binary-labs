// Drives the outcome and Check this filters, the Questions page and a row's E and C keys in the
// fixture app, headless, and saves a screenshot of each. Needs
// `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3102` (or BASE_URL).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3102";
const out = process.env.OUT_DIR ?? join(import.meta.dirname, "../screenshots");
mkdirSync(out, { recursive: true });

function assert(ok, message) {
  if (!ok) throw new Error(message);
  console.log(`ok  ${message}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
const rowNames = () => page.locator("[data-tour=results] > li [data-row-toggle] .sr-only").allTextContents();

// Filters.
await page.goto(`${base}/dev/fixtures/search?state=notes&q=drug`);
await page.locator("[data-tour=results]").waitFor();
const before = await rowNames();
await page.getByRole("button", { name: "Filters" }).click();
await page.getByRole("button", { name: "Any outcome" }).click();
await page.getByRole("menuitemradio", { name: "Failed" }).click();
await page.waitForTimeout(600);
const failed = await rowNames();
assert(failed.length > 0 && failed.length < before.length, `Failed keeps ${failed.length} of ${before.length} rows`);
await shot("search-filter-failed-open");
await page.getByRole("button", { name: "Filters" }).click();
assert(await page.getByRole("button", { name: "Remove filter Failed" }).isVisible(), "a closed Filters shows the Failed chip");
await shot("search-filter-failed-chip");
await page.getByRole("button", { name: "Remove filter Failed" }).click();
await page.waitForTimeout(600);
assert((await rowNames()).length === before.length, "removing the chip brings every row back");

await page.getByRole("button", { name: "Filters" }).click();
await page.getByRole("button", { name: "Check this only" }).click();
await page.waitForTimeout(600);
const checks = await rowNames();
assert(checks.length > 0 && checks.every((n) => n.includes("check this label")), `Check this only keeps ${checks.length} rows, each a Check this`);
await page.getByRole("button", { name: "Filters" }).click();
assert(await page.getByRole("button", { name: "Remove filter Check this" }).isVisible(), "Check this shows as a chip");
await shot("search-filter-check-chip");

// Row keys: E opens Edit labels with focus on the first value; typing in it doesn't fire C.
await page.goto(`${base}/dev/fixtures/search?state=results&q=p450%20gels`);
await page.locator("[data-tour=results]").waitFor();
await page.getByRole("button", { name: /^Details for Batch 3 gel densitometry/ }).focus();
await page.keyboard.press("e");
await page.waitForTimeout(400);
const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
assert(/^Batch 3 gel densitometry\W*edit name$/.test(focused.trim()), `E opens the labels with focus on Name ("${focused.trim()}")`);
assert(await page.locator("[data-label-fields]").isVisible(), "Edit labels is open");
await page.keyboard.press("Enter");
await page.keyboard.type(" c e");
assert(page.url().includes("/dev/fixtures/search"), "typing c and e in a field neither charts nor jumps");
await shot("search-row-edit-key");
await page.keyboard.press("Escape");

// C on a data sheet's row goes to the chart builder.
const sheet = page.locator("[data-tour=results] > li", { has: page.locator('[aria-keyshortcuts$=" C"]') }).first();
assert((await sheet.count()) === 1, "a data sheet's row lists C among its keys");
await sheet.locator("[data-row-toggle]").focus();
await page.keyboard.press("c");
await page.waitForURL(/\/charts/, { timeout: 5000 }).catch(() => undefined);
assert(/\/charts/.test(page.url()), `C opens the chart builder (${new URL(page.url()).pathname})`);

// Show all questions leads to the Questions page, which searches.
await page.goto(`${base}/dev/fixtures/ask?view=home`);
await page.getByRole("link", { name: "Show all questions" }).click();
await page.waitForURL(/\/questions/);
assert(true, "Show all questions leads to /questions");
await page.goto(`${base}/dev/fixtures/questions`);
await page.getByRole("heading", { name: "Questions" }).waitFor();
await page.locator("ul a").first().waitFor();
const all = await page.locator("ul a").count();
assert(all === 12, `the Questions page lists all ${all} questions`);
await shot("questions-all");
await page.getByLabel("Search questions").fill("a420");
await page.waitForTimeout(600);
const found = await page.locator("ul a").allTextContents();
assert(found.length === 1 && found[0].includes("A420/A280"), `searching a420 finds "${found[0]}"`);
const href = await page.locator("ul a").first().getAttribute("href");
assert(href?.startsWith("/?q=") && href.includes("ask="), `a question opens on Search with its answer (${href})`);
await shot("questions-search");
await page.getByLabel("Search questions").fill("zebrafish");
await page.waitForTimeout(600);
assert(await page.getByText("No questions match").isVisible(), "a search with no match says so");

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}/dev/fixtures/questions`);
await page.locator("ul a").first().waitFor();
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert(overflow <= 0, `no sideways scroll at 390 px (${overflow})`);
await shot("questions-phone");

await browser.close();
