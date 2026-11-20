// Headless screenshots of the task page's fixture, and a walk through it that fails if a step
// doesn't land. Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3116`.
//   BASE_URL=http://localhost:3116 node scripts/task-export-shots.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3116";
const out = join(import.meta.dirname, "../screenshots");
mkdirSync(out, { recursive: true });
const at = (view) => `/dev/fixtures/run-export?view=${view}`;

const showRecord = async (page) => {
  await page.getByRole("button", { name: "Show the record with names taken out" }).click();
  await page.getByText("Binary replaced 3 people, 1 sample ID").waitFor();
};

const shots = [
  { name: "task-start", view: "start" },
  { name: "task-written", view: "written" },
  {
    name: "task-preview",
    view: "written",
    steps: async (page) => {
      await showRecord(page);
      await page.getByText("context.md", { exact: true }).click();
      await page.getByText("answer_key.md", { exact: true }).click();
    },
  },
  {
    name: "task-exclusions",
    view: "written",
    steps: async (page) => {
      await page.getByText("What this lab leaves out").click();
      await page.getByRole("checkbox", { name: "Images" }).click();
      await page.getByText("What this lab leaves out (1)").waitFor();
      await showRecord(page);
      await page.getByText("Left out. The lab leaves this kind of file out.").waitFor();
    },
  },
  { name: "task-waiting", view: "waiting" },
  { name: "task-built", view: "built" },
  { name: "task-demo", view: "demo" },
];

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }) });
const open = async (view, width, scheme) => {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: scheme, reducedMotion: "reduce", deviceScaleFactor: width < 500 ? 2 : 1 });
  const page = await context.newPage();
  await page.goto(base + at(view), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
};
const check = (ok, what) => {
  if (!ok) throw new Error(`not on screen: ${what}`);
  process.stdout.write(`ok  ${what}\n`);
};

try {
  for (const shot of shots) {
    for (const [width, scheme] of [[1440, "light"], [390, "dark"]]) {
      const { context, page } = await open(shot.view, width, scheme);
      if (shot.steps) await shot.steps(page);
      await page.waitForTimeout(300);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(out, `${shot.name}-${width}-${scheme}.png`), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(overflow <= 0, `${shot.name} at ${width}px fits its width`);
      await context.close();
    }
  }

  // Writing the task, from nothing, as the second scientist.
  {
    const { context, page } = await open("start", 1440, "light");
    check(await page.getByText("The question and rubric aren't written yet.").isVisible(), "a new task says what is missing");
    check((await page.getByLabel("Who is reviewing?").locator("option").allTextContents()).join("|") === "Pick a person|Ade Okafor|Jordan Morales", "the person who ran it can't be picked as reviewer");
    await page.getByRole("button", { name: "Save" }).click();
    check(await page.getByRole("alert").filter({ hasText: "Write the question." }).isVisible(), "an empty form says what to write first");
    await page.getByLabel("The question").fill("Why is there no band at 119 kDa?");
    await page.getByLabel("Line 1", { exact: true }).fill("Names the IPTG stock as the cause");
    await page.getByRole("button", { name: "Add a line" }).click();
    await page.getByLabel("Line 2", { exact: true }).fill("Says a repeat with fresh IPTG would show it");
    await page.getByLabel("Points for line 2").selectOption("3");
    check(await page.getByText("8 points in all").isVisible(), "the points add up as lines are written");
    await page.getByRole("radio", { name: "Yes" }).check();
    await page.getByLabel("Review notes").fill("I saw the repeat gel.");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Nothing. This run can become a task.").waitFor();
    check(true, "saving the task clears what was needed");
    await context.close();
  }

  // Checking the record, then building and getting a download.
  {
    const { context, page } = await open("written", 1440, "light");
    const build = page.getByRole("button", { name: "Build the task folder" });
    check(await build.isDisabled(), "nothing can be built before the record is read");
    await showRecord(page);
    // What would leave: every written part (textContent reads the closed ones too), the top
    // of each scrubbed file, and the files' new names.
    const record = [...(await page.locator("pre").allTextContents()), ...(await page.getByText(/^evidence\//).allTextContents())].join("\n");
    check(record.includes("# Answer key") && record.includes("evidence/01-Person A_gel_lanes_2026-10-15.csv"), "the record on screen is the whole folder");
    for (const name of ["Priya", "Nair", "Jordan", "Morales", "Okafor", "PN-042", "@university.edu"]) check(!record.includes(name), `"${name}" is nowhere in the record as it would leave`);
    check(await page.getByText("evidence/02-Sample 1 BM3 gel.tif", { exact: true }).isVisible(), "a file's new name is shown beside its old one");
    check(await page.getByText("2 files go in exactly as they are.").isVisible(), "files nobody can look inside are called out");
    check(await build.isDisabled(), "reading isn't enough: the box has to be ticked");
    await page.getByRole("checkbox", { name: /I.ve read the record above/ }).check();
    await build.click();
    await page.getByRole("link", { name: "Download" }).waitFor();
    check((await page.getByRole("link", { name: "Download" }).getAttribute("href")).startsWith("/api/run-records/"), "a built folder has a download that goes through Binary");
    await context.close();
  }

  // A run that may not leave: no build button to press, and the reasons in plain words.
  {
    const { context, page } = await open("waiting", 1440, "light");
    check(await page.getByText("Sharing is off for this run.").isVisible(), "a run that isn't shared says so");
    check((await page.getByRole("button", { name: "Build the task folder" }).count()) === 0, "a blocked run has no build button");
    check(await page.getByText("This lab leaves out: Images.").isVisible(), "a member sees what the lab leaves out and can't change it");
    await context.close();
  }
  {
    const { context, page } = await open("demo", 1440, "light");
    check(await page.getByText("SAMPLE. This is a demo lab").isVisible(), "a demo lab's task page says SAMPLE");
    await context.close();
  }
  {
    const { context, page } = await open("built", 1440, "light");
    check(await page.getByText("Copies someone already downloaded can't be pulled back.").isVisible(), "a withdrawn folder says what can't be undone");
    check((await page.getByRole("link", { name: "Download" }).count()) === 1, "only the folder that still stands can be downloaded");
    await context.close();
  }
} finally {
  await browser.close();
}
