// Headless screenshots of sharing on the fixture pages, and a check of what each one reads.
// Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3113`.
//   BASE_URL=http://localhost:3113 node scripts/run-sharing-shots.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3113";
const out = join(import.meta.dirname, "../screenshots");
mkdirSync(out, { recursive: true });

const run = (view, query = "") => `/dev/fixtures/run-records?view=${view}${query}`;
const settings = (query) => `/dev/fixtures/settings/sharing?${query}`;
const SENT = "Copies already sent to someone else can't be pulled back.";

// Each shot: where, what to do there, and the words that must (and must not) be on screen.
const shots = [
  { name: "run-share-off", path: run("failed"), reads: ["Sharing is off for this run.", "Turn sharing on", "Draft wording, not yet read by a lawyer."], lacks: ["Sharing history"] },
  {
    name: "run-share-on",
    path: run("failed"),
    steps: (page) => page.getByRole("button", { name: "Turn sharing on" }).click(),
    reads: ["Sharing is on for this run.", "This run can be shared outside the lab.", "Priya Nair turned sharing on for this run."],
  },
  {
    name: "run-share-lab-off",
    path: run("failed", "&lab=off"),
    steps: (page) => page.getByRole("button", { name: "Turn sharing on" }).click(),
    reads: ["Sharing is on for this run.", "Nothing can leave the lab yet: the lab hasn't agreed to share.", "Settings, Sharing"],
    lacks: ["This run can be shared outside the lab."],
  },
  {
    name: "run-share-confirm",
    path: run("retry"),
    steps: (page) => page.getByRole("button", { name: "Turn sharing off" }).click(),
    reads: ["Binary built 1 task folder from this run.", SENT, "Keep it on", "Sharing is on for this run."],
  },
  {
    name: "run-share-withdrawn",
    path: run("retry"),
    steps: async (page) => {
      await page.getByRole("button", { name: "Turn sharing off" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Turn sharing off" }).click();
    },
    reads: ["Sharing is off for this run.", "1 task folder built from this run was withdrawn.", "1 task folder built from this run withdrawn. Binary removes its copies."],
  },
  {
    name: "run-share-not-yours",
    path: run("unmarked"),
    reads: ["Only Jordan Morales, who ran it, or an admin can change this.", "the person named as confirming the cause hasn't said so themselves"],
    lacks: ["Turn sharing off", "Turn sharing on", "This run can be shared outside the lab."],
  },
  { name: "settings-sharing-off", path: settings("sharing=off"), reads: ["Draft wording. A lawyer hasn't read this yet", "The lab hasn't agreed", "Agree for the lab", "Wording draft-1", "Nothing yet."] },
  {
    name: "settings-sharing-agreed",
    path: settings("sharing=off"),
    steps: (page) => page.getByRole("button", { name: "Agree for the lab" }).click(),
    reads: ["The lab has agreed", "to wording draft-1", "Take back the agreement", "Ade Okafor agreed to share for the lab (wording draft-1)."],
    lacks: ["Agree for the lab"],
  },
  { name: "settings-sharing-on", path: settings("sharing=on"), reads: ["The lab has agreed", "Sharing history", "asked to export the run BM3 expression, induced at 18 °C. Allowed."] },
  {
    name: "settings-sharing-take-back",
    path: settings("sharing=on"),
    steps: (page) => page.getByRole("button", { name: "Take back the agreement" }).click(),
    reads: ["Take back the lab's agreement?", "those copies can't be pulled back", "Keep the agreement"],
  },
  { name: "settings-sharing-member", path: settings("sharing=off&role=member"), reads: ["Only an admin can agree for the lab."], lacks: ["Agree for the lab", "Sharing history"] },
  { name: "settings-sharing-demo", path: settings("sharing=demo"), reads: ["This is a demo lab", "marked SAMPLE"], lacks: ["Agree for the lab"] },
];

const sizes = [
  { width: 1440, height: 900, scheme: "light" },
  { width: 390, height: 844, scheme: "dark" },
];

const browser = await chromium.launch();
const failures = [];
for (const shot of shots) {
  for (const { width, height, scheme } of sizes) {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
    await page.goto(base + shot.path, { waitUntil: "networkidle" });
    await shot.steps?.(page);
    await page.waitForTimeout(500);
    const text = (await page.locator("body").innerText()).replaceAll("’", "'");
    for (const words of shot.reads ?? []) if (!text.includes(words)) failures.push(`${shot.name} ${width}: missing "${words}"`);
    for (const words of shot.lacks ?? []) if (text.includes(words)) failures.push(`${shot.name} ${width}: shows "${words}"`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) failures.push(`${shot.name} ${width}: the page scrolls sideways by ${overflow}px`);
    await page.screenshot({ path: join(out, `${shot.name}-${width}-${scheme}.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.error(`${shots.length * sizes.length} screenshots, every line where it should be.`);
