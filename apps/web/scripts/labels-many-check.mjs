// Drives changing many labels at once (Search and Browse), linking a repeat run, skipping a voice
// note's question and a note as one row in Browse, in the fixture app, headless, and saves a
// screenshot of each. Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3104` (or BASE_URL).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3104";
const out = process.env.OUT_DIR ?? join(import.meta.dirname, "../screenshots");
mkdirSync(out, { recursive: true });

function assert(ok, message) {
  if (!ok) throw new Error(message);
  process.stdout.write(`ok  ${message}\n`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
const shot = (name, full = true) => page.screenshot({ path: join(out, `${name}.png`), fullPage: full });
const toast = () => page.locator("[data-sonner-toast]").last();
const bar = () => page.getByRole("region", { name: "Change the picked files" });
const row = (title) => page.locator("[data-tour=results] > li", { has: page.getByRole("button", { name: new RegExp(`^Details for ${title}`) }) });
const PLATE2 = "HeLa drug A MTT read, plate 2";
const PLATE3 = "HeLa drug A dose series, plate 3";
const PLATE4 = "HeLa drug A repeat with PBS edges, plate 4";

// Many files at once in Search.
await page.goto(`${base}/dev/fixtures/search?state=notes&q=drug`);
await page.locator("[data-tour=results]").waitFor();
assert((await page.getByRole("checkbox").count()) === 0, "rows at rest have no boxes");
await page.getByRole("button", { name: "Select" }).click();
assert(await bar().getByText("Pick the files to change").isVisible(), "Select shows the boxes and says what to do");
await page.getByRole("checkbox", { name: `Select ${PLATE2}` }).check();
await page.getByRole("checkbox", { name: `Select ${PLATE3}` }).check();
// X on a focused row picks it too.
await row(PLATE4).locator("[data-row-toggle]").focus();
await page.keyboard.press("x");
assert(await bar().getByText("3 files picked").isVisible(), "two ticks and X pick three files");
await bar().getByLabel("Change").selectOption("outcome");
await bar().getByLabel("to").selectOption("failed");
const line = await bar().locator("p[aria-live]").last().textContent();
assert(line?.startsWith("Changes 2 files. 1 already has it."), `the count says what will change ("${line}")`);
await shot("labels-many-search-bar");
await bar().getByRole("button", { name: "Apply to 2 files" }).click();
await toast().getByText("Mark as failed on 2 files").waitFor();
assert(true, "the toast names the change and the count");
assert((await row(PLATE4).textContent())?.includes("outcome: failed") === true, "plate 4 shows failed at once");
assert(!(await bar().isVisible()), "applying ends picking");
await shot("labels-many-search-done", false);
await toast().getByRole("button", { name: "Undo" }).click();
await page.getByText("Change undone").waitFor();
assert((await row(PLATE4).textContent())?.includes("outcome: final") === true, "Undo puts plate 4 back to final");
assert((await row(PLATE2).textContent())?.includes("outcome: worked") === true, "and plate 2 back to worked");

// A repeat linked to the run it repeats, shown on both.
await page.goto(`${base}/dev/fixtures/search?state=notes&q=drug`);
await page.locator("[data-tour=results]").waitFor();
await row(PLATE4).locator("[data-row-toggle]").click();
await row(PLATE4).getByRole("button", { name: "Edit labels" }).click();
await row(PLATE4).getByRole("radio", { name: "A repeat" }).click();
await row(PLATE4).getByRole("button", { name: "Pick the run" }).click();
await row(PLATE4).getByRole("button", { name: new RegExp(`^${PLATE3}`) }).waitFor();
await shot("labels-repeat-picker");
await row(PLATE4).getByRole("button", { name: new RegExp(`^${PLATE3}`) }).click();
await toast().getByText(`Linked to “${PLATE3}”`).waitFor();
await row(PLATE4).getByRole("button", { name: "Done" }).click();
assert(await row(PLATE4).getByText(`A repeat of ${PLATE3}`).isVisible(), "the repeat says which run it repeats");
const runLink = await row(PLATE4).getByRole("link", { name: PLATE3 }).getAttribute("href");
assert(runLink?.includes("open=") === true, `the run is a link that opens it (${runLink})`);
await page.waitForTimeout(400);
await row(PLATE4).screenshot({ path: join(out, "labels-repeat-of.png") });
await row(PLATE4).locator("[data-row-toggle]").click();
await row(PLATE3).locator("[data-row-toggle]").click();
await row(PLATE3).getByText(`Repeated in ${PLATE4}`).waitFor();
assert(true, "the run it repeats says it was repeated, and where");
await page.waitForTimeout(400);
await row(PLATE3).screenshot({ path: join(out, "labels-repeated-in.png") });

// A voice note's question skipped, and brought back.
await page.goto(`${base}/dev/fixtures/talk-throughs?view=question`);
const question = page.getByText("Which experiment was “that thing from Tuesday”?");
await question.waitFor();
await shot("labels-question-skip-before");
await page.getByRole("button", { name: "Skip" }).click();
await question.waitFor({ state: "detached" });
await toast().getByText("Question skipped").waitFor();
assert(true, "Skip takes the question away and says so");
await toast().getByRole("button", { name: "Undo" }).click();
await question.waitFor();
assert(true, "Undo asks it again");

// A note is one row in Browse, and Browse picks rows too.
await page.goto(`${base}/dev/fixtures/browse?path=People/AO&notes=1`);
const files = page.getByRole("table", { name: "Files" });
await files.waitFor();
const rows = await files.locator("tbody > tr").count();
assert(rows === 3, `12 notebook pages and 2 files make 3 rows (${rows})`);
assert(await files.getByText(PLATE3).isVisible(), "the note row reads as the note");
assert(await files.getByRole("cell", { name: "Note, 12 pages", exact: true }).isVisible(), "and says it has 12 pages");
await files.getByRole("button", { name: PLATE3 }).click();
await page.getByText("Page 1 of 12").first().waitFor({ timeout: 5000 }).catch(() => undefined);
await shot("browse-note-row");
await files.getByRole("button", { name: PLATE3 }).click();
await page.getByRole("button", { name: "Select" }).click();
await page.getByRole("checkbox", { name: `Select ${PLATE3}` }).check();
await page.getByRole("checkbox", { name: "Select plate2_A570.csv" }).check();
await bar().getByLabel("Change").selectOption("add_tag");
await bar().getByLabel("named").fill("edge drift");
assert((await bar().locator("p[aria-live]").last().textContent())?.startsWith("Changes 2 files.") === true, "Browse counts the change the same way");
await shot("browse-many-bar");
await bar().getByRole("button", { name: "Apply to 2 files" }).click();
await toast().getByText("Add the tag “edge drift” on 2 files").waitFor();
assert(true, "Browse applies it to both");

// Phones: the bar fits.
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}/dev/fixtures/search?state=notes&q=drug`);
await page.locator("[data-tour=results]").waitFor();
await page.getByRole("button", { name: "Select" }).click();
await page.getByRole("checkbox", { name: `Select ${PLATE2}` }).check();
await bar().getByLabel("Change").selectOption("experiment");
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
assert(overflow <= 0, `no sideways scroll at 390 px with the bar open (${overflow})`);
await shot("labels-many-phone", false);

await browser.close();
