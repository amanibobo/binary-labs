// Headless screenshots of People linked to accounts on the fixture pages, and a check of what
// each one reads. Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3118`.
//   BASE_URL=http://localhost:3118 node scripts/people-accounts-shots.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3118";
const out = join(import.meta.dirname, "../screenshots");
mkdirSync(out, { recursive: true });

const people = (query = "") => `/dev/fixtures/settings/people${query}`;
const NOT_LINKED = "Jordan Morales isn't linked to a Binary account yet, so they can't say yes here.";

// Each shot: where, what to do there, and the words that must (and must not) be on screen.
const shots = [
  {
    name: "run-this-is-me",
    path: "/dev/fixtures/run-failure?view=unlinked",
    reads: [NOT_LINKED, "Are you Jordan Morales?", "This is me"],
    lacks: ["An admin can link them", "Yes, I confirmed this"],
  },
  {
    name: "run-this-is-me-done",
    path: "/dev/fixtures/run-failure?view=unlinked",
    steps: (page) => page.getByRole("button", { name: "This is me" }).click(),
    reads: ["You're named as the confirmer.", "Yes, I confirmed this"],
    lacks: [NOT_LINKED],
  },
  {
    name: "run-remove-type",
    path: "/dev/fixtures/run-records?view=failed",
    steps: async (page) => {
      await page.getByLabel("What kind of experiment was it?").selectOption({ label: "Western blot" });
      await page.waitForTimeout(400);
      await page.getByRole("radio", { name: /Worked/ }).click();
    },
    reads: ["This run has a failure type picked. Marking it worked removes it. The run's history keeps what it was.", "Remove the failure type", "Keep it as it is"],
    lacks: ["Remove the cause"],
  },
  {
    name: "run-remove-both",
    path: "/dev/fixtures/run-failure?view=unlinked",
    steps: (page) => page.getByRole("radio", { name: /Worked/ }).click(),
    reads: ["This run has a cause and a failure type written down. Marking it worked removes them. The run's history keeps what they were.", "Remove the cause and the failure type"],
  },
  {
    name: "settings-people-admin",
    path: people(),
    reads: ["You, signed in as a.okafor@university.edu", "Signs in as priya.n@university.edu", "Link", "Unlink"],
    lacks: ["This is me"],
  },
  {
    name: "settings-people-unlink",
    path: people(),
    steps: (page) => page.getByRole("button", { name: "Unlink Priya Nair" }).click(),
    reads: ["Unlink Priya Nair?", "Priya Nair said yes to 2 confirmed causes from this account. Unlinking takes those back", "can't say yes as Priya Nair any more"],
  },
  {
    name: "settings-people-link",
    path: people(),
    steps: (page) => page.getByRole("button", { name: "Link Jordan Morales to an account" }).click(),
    reads: ["Link Jordan Morales to an account", "Which member is Jordan Morales?", "j.morales@university.edu"],
  },
  {
    name: "settings-people-member",
    path: people("?role=member&me=jordan"),
    reads: ["This is me", "Signs in as priya.n@university.edu"],
    lacks: ["Unlink", "Link Jordan"],
  },
  {
    name: "settings-members-remove",
    path: "/dev/fixtures/settings/members",
    steps: (page) => page.getByRole("button", { name: "Remove" }).first().click(),
    reads: ["Priya Nair said yes to 2 confirmed causes from this account. Removing them takes those back"],
  },
];

const sizes = [
  { width: 1280, height: 900, scheme: "light" },
  { width: 390, height: 844, scheme: "dark" },
];

const browser = await chromium.launch();
const failures = [];
for (const shot of shots) {
  for (const { width, height, scheme } of sizes) {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
    await page.goto(base + shot.path, { waitUntil: "networkidle" });
    try {
      await shot.steps?.(page);
    } catch (error) {
      failures.push(`${shot.name} ${width}: ${String(error).split("\n")[0]}`);
    }
    await page.waitForTimeout(600);
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
