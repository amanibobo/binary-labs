// Does a first-year student's chart tasks in the fixture app, headless, counting every click and
// checking each task's result (decisions.md, "charts for a first-year student" and "charts round
// 1"). Needs
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
      await t.sees(/A595 for 8 BSA values from 0 to 2,000 µg\/mL, each the mean of 3 repeats, with a straight line fitted to them/);
      await t.click(t.page.getByRole("button", { name: "Save", exact: true }), "saves");
      await t.sees("Chart saved");
    },
  },
  {
    name: "Kinetic plate read as a line chart of 3 wells, saved",
    path: c("new"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: "How something changes" }), "picks the suggested kind of chart");
      await t.sees("A1, D9 and H2 as Time goes from 0 to 30 min, 31 points each.");
      await t.click(t.page.getByRole("button", { name: "Save", exact: true }), "saves");
      await t.sees("Chart saved");
    },
  },
  {
    name: "The same, with wells A1, D1 and H1 picked on the plate",
    path: c("new"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: "How something changes" }), "picks the suggested kind of chart");
      for (const well of ["D9", "H2", "D1", "H1"]) await t.click(t.page.getByRole("button", { name: `Well ${well}`, exact: true }), `taps ${well}`);
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
      await t.click(t.page.getByRole("menuitem", { name: /PNG picture/ }), "picks a PNG");
      const file = await download;
      if (!file.suggestedFilename().endsWith(".png")) throw new Error(`downloaded ${file.suggestedFilename()}`);
      t.note(`downloaded ${file.suggestedFilename()}`);
    },
  },
  {
    name: "Bradford plate: standards, blanks and samples read off the curve",
    path: c("bradford-plate"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: /^How two measurements relate/ }), "picks the suggested standard curve");
      await t.sees("Your samples, read off the line");
      await t.click(t.page.getByRole("radio", { name: "mg/mL" }), "shows mg/mL");
      await t.sees("13.1");
    },
  },
  {
    name: "Knockdown vs control, with the test named",
    path: c("knockdown"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: /^Compare groups/ }), "picks the suggested bars");
      await t.sees("Unlikely: Welch's t-test, p = 0.0002");
    },
  },
  {
    name: "IC50 of drug A from a plate with its layout",
    path: c("dose"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: /^How a dose changes the effect/ }), "picks the suggested dose-response");
      await t.sees(/Relative IC50 2\.\d+ µM, 95% CI/);
    },
  },
  {
    name: "IC50 of drug A, marking the plate by hand",
    path: c("dose-paint"),
    async run(t) {
      const page = t.page;
      await t.click(page.getByRole("button", { name: "Mark the wells" }), "opens Mark the wells");
      const dialog = page.getByRole("dialog");
      const pick = async (from, to) => {
        await t.click(dialog.getByRole("gridcell", { name: new RegExp(`^${from},`) }), `picks ${from}`);
        await t.shiftClick(dialog.getByRole("gridcell", { name: new RegExp(`^${to},`) }), `shift-clicks ${to}`);
      };
      await pick("B1", "D1");
      await t.click(dialog.getByRole("radio", { name: /^Blank/ }), "says blank");
      await t.click(dialog.getByRole("button", { name: /^Mark 3 wells/ }), "marks them");
      await pick("B2", "D2");
      await t.click(dialog.getByRole("radio", { name: /^Control/ }), "says control");
      await t.click(dialog.getByRole("button", { name: /^Mark 3 wells/ }), "marks them");
      await pick("B3", "D7");
      await t.click(dialog.getByRole("button", { name: "Fill a dilution series" }), "opens the dilution series");
      await dialog.getByLabel("Name", { exact: true }).last().fill("Drug A");
      await dialog.getByLabel("Start at").fill("100");
      await dialog.getByLabel("Unit").last().fill("µM");
      await dialog.getByLabel("Divide by").fill("5");
      await t.click(dialog.getByRole("button", { name: /^Fill 5 columns/ }), "fills 5 columns");
      await t.click(dialog.getByRole("button", { name: "Done, use this layout" }), "uses the layout");
      await t.click(page.getByRole("button", { name: /^How a dose changes the effect/ }), "picks the dose-response it now suggests");
      await t.sees(/IC50 \d\.\d+ µM, 95% CI/);
    },
  },
  {
    name: "Histogram of 200 cell sizes",
    path: c("cells"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: /^How values are spread/ }), "picks the suggested histogram");
      await t.sees("counted in bins 1 µm wide");
    },
  },
  {
    name: "A figure for a paper: PDF at one journal column",
    path: c("saved-dose"),
    async run(t) {
      await t.click(t.page.getByRole("button", { name: "Download" }), "opens Download");
      const download = t.page.waitForEvent("download");
      await t.click(t.page.getByRole("menuitem", { name: /^PDF/ }), "picks PDF at the 85 mm it starts on");
      const file = await download;
      if (!file.suggestedFilename().endsWith(".pdf")) throw new Error(`downloaded ${file.suggestedFilename()}`);
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
      async shiftClick(locator, why) {
        await locator.click({ modifiers: ["Shift"] });
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
