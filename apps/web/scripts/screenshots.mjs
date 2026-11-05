// Headless screenshots of the fixture pages. Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3100`.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const out = join(import.meta.dirname, "../screenshots");
mkdirSync(out, { recursive: true });

const results = "/dev/fixtures/search?state=results&q=p450%20gels";
const expandGel = (page) => page.getByRole("button", { name: "Details for Batch 3 SDS-PAGE gel" }).click();

const shots = [
  { name: "browse-root", path: "/dev/fixtures/browse", width: 1440, scheme: "dark" },
  { name: "browse-subfolder", path: "/dev/fixtures/browse?path=P450%2Fbatch3", steps: (page) => page.getByRole("button", { name: "Batch 3 yields.xlsx" }).click(), width: 1440, scheme: "dark" },
  { name: "browse-root", path: "/dev/fixtures/browse", width: 1440, scheme: "light" },
  { name: "nav-menu", path: "/dev/fixtures/browse?path=P450", steps: (page) => page.getByRole("button", { name: "Account and navigation" }).click(), full: false, width: 390, scheme: "dark" },
  { name: "search-results", path: results, steps: expandGel, width: 1440, scheme: "dark" },
  {
    name: "search-check",
    path: results,
    steps: (page) => page.getByRole("button", { name: "Check this label" }).click(),
    width: 1440,
    scheme: "dark",
  },
  {
    name: "search-editor",
    path: results,
    steps: async (page) => {
      await page.getByRole("button", { name: /^Batch 3 gel densitometry.*rename$/ }).click();
      await page.keyboard.type("Batch 3 densitometry, lanes 1 to 8");
    },
    width: 1440,
    scheme: "dark",
  },
  { name: "needs-a-look", path: "/dev/fixtures/needs-a-look", width: 1440, scheme: "dark" },
  { name: "settings", path: "/dev/fixtures/lab", width: 1440, scheme: "dark" },
  { name: "sign-in", path: "/sign-in", width: 1440, scheme: "dark" },
  { name: "new-lab", path: "/dev/fixtures/new-lab", width: 1440, scheme: "dark" },
  { name: "lab-folder", path: "/dev/fixtures/folder", width: 1440, scheme: "dark" },
  { name: "search-palette", path: "/dev/fixtures/search?state=empty", palette: "p450", width: 1440, scheme: "dark" },
  ...protocolShots(),
  ...deletionShots(),
  ...uploadShots(),
  ...talkThroughShots(),
];

// Deleting a lab and disconnecting Dropbox, in both schemes.
function deletionShots() {
  const both = (shot) => ["dark", "light"].map((scheme) => ({ width: 1440, ...shot, scheme }));
  const openDelete = async (page) => {
    await page.getByRole("button", { name: "Delete lab" }).click();
    await page.getByLabel("Type Okafor Lab to confirm").fill("Okafor Lab");
  };
  return [
    ...both({ name: "settings-delete-section", path: "/dev/fixtures/lab?state=connect" }),
    ...both({ name: "settings-delete-dialog", path: "/dev/fixtures/lab", steps: openDelete, full: false }),
    { name: "settings-delete-dialog", path: "/dev/fixtures/lab", steps: openDelete, full: false, width: 390, scheme: "dark" },
    ...both({
      name: "settings-disconnect-dialog",
      path: "/dev/fixtures/lab",
      steps: (page) => page.getByRole("button", { name: "Disconnect", exact: true }).click(),
      full: false,
    }),
    ...both({ name: "settings-disconnected", path: "/dev/fixtures/lab?state=disconnected" }),
    { name: "settings-member", path: "/dev/fixtures/lab?role=member", width: 1440, scheme: "dark" },
    ...both({ name: "lab-deleted-pending", path: "/dev/fixtures/deleted?state=pending" }),
    ...both({ name: "lab-deleted-done", path: "/dev/fixtures/deleted?state=done" }),
  ];
}


// The upload page idle, mid-upload and done, in both schemes at desktop and phone width,
// and search finding an uploaded photo.
function uploadShots() {
  const chooseFiles = (page, names) =>
    page.locator('input[type="file"][multiple]').setInputFiles(
      names.map((name) => ({
        name,
        mimeType: name.endsWith(".pdf") ? "application/pdf" : "image/png",
        buffer: name.endsWith(".pdf") ? Buffer.alloc(240_000, 1) : gelPng,
      })),
    );
  const views = [
    { name: "upload", path: "/dev/fixtures/upload" },
    {
      name: "upload-progress",
      path: "/dev/fixtures/upload",
      steps: async (page) => {
        await chooseFiles(page, ["Gel batch 5.png", "Western blot lanes 1-6.png", "SEC trace notes.pdf"]);
        await page.getByRole("progressbar").waitFor();
        await page.getByText("Trying again in a moment").waitFor();
      },
    },
    {
      name: "upload-done",
      path: "/dev/fixtures/upload",
      steps: async (page) => {
        await chooseFiles(page, ["Gel batch 5.png"]);
        await page.getByText("Batch 5 SDS-PAGE gel").waitFor({ timeout: 10_000 });
      },
    },
  ];
  const extras = [
    { name: "upload-first", path: "/dev/fixtures/upload?state=first", width: 390, scheme: "dark" },
    ...[1440, 390].map((width) => ({
      name: "search-upload",
      path: "/dev/fixtures/search?state=results&q=p450%20gels",
      steps: (page) => page.getByRole("button", { name: "Details for Batch 4 SDS-PAGE gel" }).click({ position: { x: 8, y: 8 } }),
      width,
      scheme: "dark",
    })),
  ];
  return [
    ...views.flatMap((v) => ["dark", "light"].flatMap((scheme) => [1440, 390].map((width) => ({ ...v, width, scheme })))),
    ...extras,
  ];
}

// Recording a talk-through (Chromium's fake microphone plays a tone), the recording on its way
// through transcription and drafting, the draft beside its transcript, and the editor it opens.
function talkThroughShots() {
  const t = (view) => `/dev/fixtures/talk-throughs?view=${view}`;
  const record = async (page) => {
    await page.getByRole("button", { name: "Start recording" }).click();
    await page.getByText("Recording", { exact: true }).waitFor();
    await page.waitForTimeout(2600);
  };
  const recorded = async (page) => {
    await record(page);
    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Send for steps" }).waitFor();
  };
  const all = (shot) => ["dark", "light"].flatMap((scheme) => [1440, 390].map((width) => ({ ...shot, width, scheme })));
  return [
    ...all({ name: "talk-record", path: t("record") }),
    ...all({ name: "talk-recording", path: t("record"), steps: record }),
    ...all({ name: "talk-recorded", path: t("record"), steps: recorded }),
    { name: "talk-record-new", path: t("record-new"), width: 390, scheme: "dark" },
    ...all({ name: "talk-transcribing", path: t("transcribing") }),
    ...all({ name: "talk-drafting", path: t("drafting") }),
    ...all({ name: "talk-ready", path: t("ready") }),
    ...["dark", "light"].map((scheme) => ({ name: "talk-failed", path: t("failed"), width: 1440, scheme })),
    { name: "talk-no-draft", path: t("no-draft"), width: 1440, scheme: "dark" },
    ...["dark", "light"].map((scheme) => ({ name: "talk-edit", path: t("edit"), width: 1440, scheme })),
    { name: "talk-edit-new", path: t("edit-new"), width: 390, scheme: "dark" },
  ];
}

// Every protocol screen in both schemes, at desktop and phone width.
function protocolShots() {
  const p = (view) => `/dev/fixtures/protocols?view=${view}`;
  const views = [
    { name: "protocols-list", path: p("list") },
    { name: "protocols-page", path: p("page") },
    { name: "protocols-edit", path: p("edit") },
    { name: "protocols-history", path: p("history") },
    { name: "search-protocols", path: "/dev/fixtures/search?state=results&q=gel" },
  ];
  const extras = [
    { name: "protocols-old-version", path: p("old"), width: 1440, scheme: "dark" },
    { name: "protocols-new-from-file", path: p("from"), width: 1440, scheme: "dark" },
    { name: "protocols-empty", path: p("empty"), width: 1440, scheme: "dark" },
    {
      name: "protocols-preview",
      path: p("edit"),
      steps: (page) => page.getByRole("tab", { name: "Preview" }).click(),
      width: 1440,
      scheme: "dark",
    },
    {
      name: "protocols-stale",
      path: p("stale"),
      steps: async (page) => {
        await page.getByRole("textbox", { name: "Text", exact: true }).fill("1. Thaw the pellet on ice for 30 min.");
        await page.getByRole("button", { name: "Save version" }).click();
        await page.getByRole("button", { name: "Load their version" }).click();
        await page.getByText("Show their text").waitFor();
      },
      width: 1440,
      scheme: "dark",
    },
    {
      name: "protocols-picker",
      path: p("page"),
      steps: async (page) => {
        await page.getByRole("button", { name: "Link a file" }).click();
        await page.getByPlaceholder("Search files").fill("gel");
        await page.getByRole("button", { name: /^Link Batch 3 gel densitometry/ }).waitFor();
      },
      full: false,
      width: 1440,
      scheme: "dark",
    },
    {
      name: "search-make-protocol",
      path: "/dev/fixtures/search?state=results&q=purification",
      steps: (page) => page.getByRole("button", { name: "Details for P450 BM3 purification protocol, v3" }).click(),
      width: 1440,
      scheme: "dark",
    },
  ];
  return [
    ...views.flatMap((v) =>
      ["dark", "light"].flatMap((scheme) => [1440, 390].map((width) => ({ ...v, width, scheme }))),
    ),
    ...extras,
  ];
}
const only = process.argv[2];

// A fake microphone, allowed without a prompt, for the talk-through recorder.
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
let gelPng;
try {
  gelPng = await drawGel(browser);
  for (const shot of shots) {
    const tag = `${shot.name}-${shot.width}-${shot.scheme}`;
    if (only !== undefined && !tag.includes(only)) continue;
    const context = await browser.newContext({
      viewport: { width: shot.width, height: shot.width < 500 ? 844 : 900 },
      colorScheme: shot.scheme,
      reducedMotion: "reduce",
      deviceScaleFactor: shot.width < 500 ? 2 : 1,
      permissions: ["microphone"],
    });
    const page = await context.newPage();
    await page.goto(base + shot.path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    if (shot.steps) await shot.steps(page);
    if (shot.palette) {
      await page.keyboard.press("Meta+k");
      await page.getByPlaceholder("Search files").last().fill(shot.palette);
    }
    await page.waitForTimeout(400);
    // A click can scroll the page, which would leave the sticky top bar mid-way down a full-page shot.
    if (shot.full !== false) await page.evaluate(() => window.scrollTo(0, 0));
    const file = join(out, `${tag}.png`);
    await page.screenshot({ path: file, fullPage: !shot.palette && shot.full !== false });
    process.stdout.write(`${file}\n`);
    await context.close();
  }
} finally {
  await browser.close();
}

// A real PNG for the upload shots, so the queue's thumbnails show a gel photo.
async function drawGel(browser) {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  const lanes = Array.from({ length: 8 }, (_, i) =>
    [96, 150, 205].map((y, j) => `<rect x="${36 + i * 54}" y="${y + (i % 3) * 5}" width="40" height="7" rx="3" fill="#e9eee8" opacity="${0.9 - j * 0.22}"/>`).join(""),
  ).join("");
  await page.setContent(`<body style="margin:0"><svg width="480" height="320"><rect width="480" height="320" fill="#1d2326"/>${lanes}</svg></body>`);
  const png = await page.screenshot();
  await page.close();
  return png;
}
