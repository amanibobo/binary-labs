// Does a first-year student's four chart tasks in the fixture app, headless, counting every click
// and checking each task's result (decisions.md, "charts for a first-year student"). Needs
// `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3100`.
//   node scripts/chart-tasks.mjs
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const c = (view) => `${base}/dev/fixtures/charts?view=${view}`;

const tasks = [
  {
    name: "Bradford standard curve with SD error bars, saved",
    path: c("bradford"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: "How two measurements relate" }), "picks the suggested kind of chart");
      await t.sees(/Mean \(AU\) for 8 BSA values .* with bars showing how much the repeats vary \(± SD\)\./);
      await t.click(t.page.getByRole("button", { name: "Save", exact: true }), "saves");
      await t.sees("Chart saved");
    },
  },
  {
    name: "Kinetic plate read as a line chart of 3 wells, saved",
    path: c("new"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: "How something changes" }), "picks the suggested kind of chart");
      await t.sees("A1, A2 and A3 as Time goes from 0 to 30 min, 31 points each.");
      await t.click(t.page.getByRole("button", { name: "Save", exact: true }), "saves");
      await t.sees("Chart saved");
    },
  },
  {
    name: "The same, with wells A1, D1 and H1 picked on the plate",
    path: c("new"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: "How something changes" }), "picks the suggested kind of chart");
      for (const well of ["A2", "A3", "D1", "H1"]) await t.click(t.page.getByRole("button", { name: `Well ${well}`, exact: true }), `taps ${well}`);
      await t.sees("A1, D1 and H1 as Time goes from 0 to 30 min, 31 points each.");
      await t.click(t.page.getByRole("button", { name: "Save", exact: true }), "saves");
      await t.sees("Chart saved");
    },
  },
  {
    name: "ELISA plate as a heatmap, saved",
    path: c("elisa"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: "A whole plate at a glance" }), "picks the suggested kind of chart");
      await t.sees("OD450 in each well of a 96-well plate");
      await t.click(t.page.getByRole("button", { name: "Save", exact: true }), "saves");
      await t.sees("Chart saved");
    },
  },
  {
    name: "A saved chart exported as a PNG",
    path: c("saved"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: "Download" }), "opens Download");
      const download = t.page.waitForEvent("download");
      await t.click(t.page.getByRole("menuitem", { name: /Picture for slides/ }), "picks the picture for slides");
      const file = await download;
      if (!file.suggestedFilename().endsWith(".png")) throw new Error(`downloaded ${file.suggestedFilename()}`);
      t.note(`downloaded ${file.suggestedFilename()}`);
    },
  },
];

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
});
let failed = false;
try {
  for (const task of tasks) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(task.path, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const button = document.querySelector("main button");
      return button !== null && Object.keys(button).some((k) => k.startsWith("__reactProps"));
    });
    const steps = [];
    const t = {
      page,
      async click(locator, why) {
        await locator.click();
        steps.push(why);
      },
      async sees(text) {
        await page.getByText(text).first().waitFor({ timeout: 5000 });
      },
      note(text) {
        steps.push(`(${text})`);
      },
    };
    try {
      await task.run(t);
      const clicks = steps.filter((s) => !s.startsWith("(")).length;
      process.stdout.write(`${clicks} clicks  ${task.name}\n${steps.map((s) => `          ${s}`).join("\n")}\n`);
    } catch (error) {
      failed = true;
      process.stdout.write(`FAILED    ${task.name}: ${error.message}\n`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
