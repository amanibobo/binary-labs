// Headless screenshots of the fixture pages. Needs `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3100`.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const out = join(import.meta.dirname, "../screenshots");
mkdirSync(out, { recursive: true });
const clip = readFileSync(join(import.meta.dirname, "../src/fixtures/media/bench.webm"));
const paddedClip = Buffer.concat([clip, Buffer.alloc(20 * 1024 * 1024 - clip.length)]);

const results = "/dev/fixtures/search?state=results&q=p450%20gels";
const expandGel = (page) => page.getByRole("button", { name: "Details for Batch 3 SDS-PAGE gel" }).click();

const shots = [
  { name: "browse-root", path: "/dev/fixtures/browse", width: 1440, scheme: "dark" },
  { name: "browse-subfolder", path: "/dev/fixtures/browse?path=P450%2Fbatch3", steps: (page) => page.getByRole("button", { name: "Batch 3 yields.xlsx" }).click(), width: 1440, scheme: "dark" },
  { name: "browse-root", path: "/dev/fixtures/browse", width: 1440, scheme: "light" },
  { name: "nav-menu", path: "/dev/fixtures/browse?path=P450", steps: (page) => page.getByRole("button", { name: "Menu" }).click(), full: false, width: 390, scheme: "dark" },
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
  { name: "sign-in", path: "/sign-in", width: 1440, scheme: "dark" },
  { name: "new-lab", path: "/dev/fixtures/new-lab", width: 1440, scheme: "dark" },
  { name: "lab-folder", path: "/dev/fixtures/folder", width: 1440, scheme: "dark" },
  { name: "search-palette", path: "/dev/fixtures/search?state=empty", palette: "p450", width: 1440, scheme: "dark" },
  ...protocolShots(),
  ...settingsShots(),
  ...deletionShots(),
  ...uploadShots(),
  ...talkThroughShots(),
  ...videoShots(),
  ...chartShots(),
  ...mapShots(),
  ...onboardingShots(),
  ...calendarShots(),
  ...flagShots(),
];

// The calendar, in New York the week the clocks went back: the month, the week, a day's record
// opened, an entry in the side peek with someone else's booking of the same plate reader, and
// the phone's agenda. A phone shows the agenda for the month and week views alike.
function calendarShots() {
  const c = (query) => `/dev/fixtures/calendar?${query}`;
  const both = (shot) => ["dark", "light"].map((scheme) => ({ ...shot, scheme, tz: "America/New_York", full: false }));
  const peek = async (page) => {
    await page.getByRole("dialog").getByText("is also booked").waitFor();
  };
  const day = async (page) => {
    await page.getByRole("dialog").getByText("Batch 4 SDS-PAGE gel").first().waitFor();
  };
  return [
    ...both({ name: "calendar-month", path: c("view=month"), width: 1440 }),
    ...both({ name: "calendar-week", path: c("view=week"), width: 1440 }),
    ...both({ name: "calendar-day", path: c("view=month&day=2026-11-03"), steps: day, width: 1440 }),
    ...both({ name: "calendar-peek", path: c("view=week&entry=8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c0007"), steps: peek, width: 1440 }),
    ...both({ name: "calendar-agenda", path: c("view=month"), width: 390 }),
    ...both({ name: "calendar-day", path: c("view=month&day=2026-11-03"), steps: day, width: 390 }),
    ...both({ name: "calendar-peek", path: c("view=month&entry=8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c0007"), steps: peek, width: 390 }),
    // A protocol's page with its coming entries. It reads the real clock, so it shows the
    // fixture's November entries only until they've passed.
    ...both({
      name: "calendar-on-protocol",
      path: "/dev/fixtures/protocols?view=page",
      steps: (page) => page.getByRole("heading", { name: "On the calendar" }).evaluate((el) => el.scrollIntoView({ block: "center" })),
      width: 1440,
    }).map((shot) => ({ ...shot, full: false })),
  ];
}

// Checks and flags: the check editor, a flag on a file's row and opened view, the Flags list,
// answering a flag, and a protocol page with its checks.
function flagShots() {
  const f = (view) => `/dev/fixtures/flags?view=${view}`;
  const all = (shot) => ["dark", "light"].flatMap((scheme) => [1440, 390].map((width) => ({ ...shot, width, scheme })));
  const openBradford = (page) => page.getByRole("button", { name: "Details for Bradford assay, Oct 30" }).dispatchEvent("click");
  return [
    ...all({ name: "flags-list", path: f("list") }),
    ...all({ name: "flag-curve", path: f("flag"), tall: true }),
    ...all({ name: "flag-review-wrong", path: f("wrong"), tall: true }),
    ...all({ name: "check-editor", path: f("checks") }),
    ...all({ name: "check-editor-open", path: f("checks-wrong") }),
    ...all({ name: "flag-on-file", path: "/dev/fixtures/search?state=empty", steps: openBradford }),
    { name: "flag-control", path: f("control"), width: 1440, scheme: "dark" },
    { name: "flag-answered", path: f("answered"), width: 1440, scheme: "dark", tall: true },
    { name: "flags-empty", path: f("empty"), width: 1440, scheme: "dark" },
    { name: "check-editor-empty", path: f("checks-empty"), width: 1440, scheme: "dark" },
    ...all({ name: "protocol-checks", path: f("protocol") }),
  ];
}

// Charts: the builder as it opens on the plate read, a saved curve with error bars, the
// readout on hover, the worker still reading a table, a data sheet's opened row in search
// and a protocol showing its charts.
// The lab map: the hubs, a hub opened, similar in meaning on, and the map around one file, in
// both schemes at desktop and phone width; plus two steps out and a protocol's map. The map
// settles before it's drawn (reduced motion), so each shot holds still.
function mapShots() {
  const m = (view) => `/dev/fixtures/map?view=${view}`;
  const all = (shot) => ["dark", "light"].flatMap((scheme) => [1440, 390].map((width) => ({ ...shot, width, scheme, full: false, touch: width < 500 })));
  const settle = (page) => page.waitForTimeout(1200);
  return [
    ...all({ name: "map-default", path: m("default"), steps: settle }),
    ...all({ name: "map-expanded", path: m("expanded"), steps: settle }),
    ...all({ name: "map-similar", path: m("similar"), steps: settle }),
    ...all({ name: "map-local", path: m("local"), steps: settle }),
    { name: "map-local-2", path: m("local2"), steps: settle, width: 1440, scheme: "dark", full: false },
    { name: "map-protocol", path: m("protocol"), steps: settle, width: 1440, scheme: "light", full: false },
    {
      name: "map-list",
      path: m("expanded"),
      steps: (page) => page.getByRole("button", { name: "Show as a list" }).click(),
      width: 1440,
      scheme: "dark",
      full: false,
    },
  ];
}

function chartShots() {
  const c = (view) => `/dev/fixtures/charts?view=${view}`;
  const all = (shot) => ["dark", "light"].flatMap((scheme) => [1440, 390].map((width) => ({ ...shot, width, scheme })));
  const hover = async (page) => {
    const box = await page.locator("figure svg").first().boundingBox();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  };
  return [
    ...all({ name: "chart-builder", path: c("new") }),
    ...all({ name: "chart-saved", path: c("saved") }),
    { name: "chart-sec", path: c("sec"), width: 1440, scheme: "dark" },
    { name: "chart-bradford-new", path: c("bradford"), width: 1440, scheme: "light" },
    { name: "chart-hover", path: c("sec"), steps: hover, full: false, width: 1440, scheme: "dark" },
    { name: "chart-hover", path: c("saved"), steps: hover, full: false, width: 1440, scheme: "light" },
    { name: "chart-waiting", path: c("waiting"), width: 1440, scheme: "dark" },
    {
      name: "search-chart",
      path: "/dev/fixtures/search?state=empty",
      steps: (page) => page.getByRole("button", { name: "Details for Plate 7 absorbance at 420 nm" }).click(),
      width: 1440,
      scheme: "dark",
    },
    ...all({ name: "protocols-charts", path: "/dev/fixtures/protocols?view=charts" }),
  ].map((shot) => ({ ...shot, tall: true }));
}

// The welcome, each tour step, the getting-started card, a hint, the help menu and one answer,
// in both schemes at desktop and phone width. ?onboarding= picks the state (src/fixtures/onboarding.ts).
function onboardingShots() {
  const s = (query) => `/dev/fixtures/search?${query}`;
  const all = (shot) => ["dark", "light"].flatMap((scheme) => [1440, 390].map((width) => ({ ...shot, width, scheme, full: false })));
  const tourStep = (n) => async (page) => {
    for (let i = 1; i < n; i++) {
      await page.getByRole("button", { name: "Next" }).click();
      await page.waitForTimeout(250);
    }
    await page.getByRole("dialog", { name: `Tour, ${n} of 5` }).waitFor();
    await page.waitForTimeout(500);
  };
  const openHelp = async (page) => {
    if (page.viewportSize().width < 768) await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("button", { name: "Help" }).last().click();
    await page.getByRole("menuitem", { name: "Take the tour" }).waitFor();
  };
  return [
    ...all({ name: "onboarding-welcome", path: s("onboarding=new"), steps: (page) => page.getByRole("button", { name: "Take the 1-minute tour" }).waitFor() }),
    ...[1, 2, 3, 4, 5].flatMap((n) => all({ name: `onboarding-tour-${n}`, path: s("onboarding=new&tour=1"), steps: tourStep(n) })),
    ...all({ name: "onboarding-checklist", path: s("onboarding=checklist") }),
    ...all({
      name: "onboarding-hint",
      path: s("onboarding=hints&q=p450%20gels"),
      // The first Check this sits at the screen's bottom edge; the hint waits until it's fully in view.
      steps: async (page) => {
        await page.locator('[data-hint~="check-this"]').first().evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.getByRole("button", { name: "Got it" }).waitFor({ timeout: 10_000 });
      },
    }),
    ...all({ name: "onboarding-help-menu", path: s("state=results"), steps: openHelp }),
    ...all({
      name: "onboarding-help-answer",
      path: s("state=results"),
      steps: async (page) => {
        await openHelp(page);
        await page.getByRole("menuitem", { name: "Fix a label" }).click();
        await page.getByRole("dialog", { name: "Fix a label" }).waitFor();
      },
    }),
    {
      name: "onboarding-hint-upload",
      path: "/dev/fixtures/upload?onboarding=hints",
      steps: async (page) => {
        await page.locator('input[type="file"][multiple]').setInputFiles({ name: "Gel batch 5.png", mimeType: "image/png", buffer: gelPng });
        await page.getByRole("button", { name: "Got it" }).waitFor({ timeout: 15_000 });
      },
      width: 390,
      scheme: "dark",
      touch: true,
      full: false,
    },
  ];
}

// Settings: /settings (the section list on a phone, General beside it on a desktop) and every
// section, in both schemes at desktop and phone width.
function settingsShots() {
  const s = (path) => `/dev/fixtures/settings${path}`;
  const all = (shot) => ["dark", "light"].flatMap((scheme) => [1440, 390].map((width) => ({ ...shot, width, scheme })));
  const sections = ["general", "members", "dropbox", "instruments", "experiments", "people", "account", "appearance"];
  return [
    ...all({ name: "settings", path: s("") }),
    ...sections.flatMap((section) => all({ name: `settings-${section}`, path: s(`/${section}`) })),
    ...all({ name: "settings-member-members", path: s("/members?role=member") }),
    ...all({ name: "settings-instruments-code", path: s("/instruments?code=shown") }),
    { name: "settings-instruments-paired", path: s("/instruments?code=paired"), width: 1440, scheme: "dark" },
    { name: "settings-instruments-empty", path: s("/instruments?state=connect"), width: 390, scheme: "light" },
    { name: "settings-member-instruments", path: s("/instruments?role=member"), width: 1440, scheme: "light" },
    { name: "settings-connect", path: s("/dropbox?state=connect"), width: 1440, scheme: "dark" },
    { name: "settings-dropbox-notice", path: s("/dropbox?state=connect&dropbox=denied"), width: 390, scheme: "dark" },
    { name: "settings-empty-list", path: s("/people?state=connect"), width: 390, scheme: "light" },
    { name: "settings-member-general", path: s("/general?role=member"), width: 1440, scheme: "dark" },
    { name: "settings-member-dropbox", path: s("/dropbox?role=member"), width: 1440, scheme: "dark" },
  ];
}

// Adding a video to a page on a phone (camera or file) and on a desktop, a video going up in
// parts and riding out a dropped connection, and one playing with its transcript open.
function videoShots() {
  const p = (view) => `/dev/fixtures/protocols?view=${view}`;
  const openAdd = (page) => page.getByRole("button", { name: "Add a video" }).click();
  // The fixture clip padded to three 8 MB parts. "column" holds part 2 half way; "Sonication"
  // drops part 1 once (src/fixtures/videos.ts).
  const choose = async (page, name) => {
    await openAdd(page);
    await page.locator('input[type="file"]:not([capture])').setInputFiles({ name, mimeType: "video/webm", buffer: paddedClip });
  };
  const all = (shot) => ["dark", "light"].flatMap((scheme) => [1440, 390].map((width) => ({ ...shot, width, scheme, touch: width < 500 })));
  return [
    ...all({ name: "video-add", path: p("no-videos"), steps: openAdd, full: false }),
    ...all({
      name: "video-uploading",
      path: p("no-videos"),
      steps: async (page) => {
        await choose(page, "Loading the nickel column.webm");
        await page.getByText(/Uploading, \d+%/).waitFor();
        await page.waitForTimeout(900);
      },
    }),
    ...all({
      name: "video-dropped",
      path: p("no-videos"),
      steps: async (page) => {
        await choose(page, "Sonication setup.webm");
        await page.getByText("Trying again in a moment").waitFor();
      },
    }),
    ...all({
      name: "video-playback",
      path: p("videos"),
      steps: async (page) => {
        await page.getByRole("button", { name: "Show transcript" }).click();
        await page.locator("video").first().evaluate(
          (v) =>
            new Promise((resolve) => {
              v.addEventListener("seeked", resolve, { once: true });
              v.currentTime = 2;
            }),
        );
      },
    }),
    ...["dark", "light"].map((scheme) => ({ name: "video-page", path: p("page"), width: 1440, scheme })),
  ];
}

// Deleting a lab and disconnecting Dropbox, in both schemes.
function deletionShots() {
  const both = (shot) => ["dark", "light"].map((scheme) => ({ width: 1440, ...shot, scheme }));
  const openDelete = async (page) => {
    await page.getByRole("button", { name: "Delete lab" }).click();
    await page.getByLabel("Type Okafor Lab to confirm").fill("Okafor Lab");
  };
  const openDisconnect = (page) => page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const general = "/dev/fixtures/settings/general";
  const dropbox = "/dev/fixtures/settings/dropbox";
  return [
    ...both({ name: "settings-delete-dialog", path: general, steps: openDelete, full: false }),
    { name: "settings-delete-dialog", path: general, steps: openDelete, full: false, width: 390, scheme: "dark" },
    ...both({ name: "settings-disconnect-dialog", path: dropbox, steps: openDisconnect, full: false }),
    { name: "settings-disconnect-dialog", path: dropbox, steps: openDisconnect, full: false, width: 390, scheme: "dark" },
    ...both({ name: "settings-disconnected", path: `${dropbox}?state=disconnected` }),
    { name: "settings-disconnected", path: `${dropbox}?state=disconnected`, width: 390, scheme: "dark" },
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
    await page.getByRole("button", { name: "Write up the steps" }).waitFor();
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
  // CHROMIUM_PATH runs a full Chromium headless when the headless shell isn't installed.
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
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
      // A shot can pin the browser's time zone, for pages that show the viewer's own clock.
      ...(shot.tz ? { timezoneId: shot.tz } : {}),
      deviceScaleFactor: shot.width < 500 ? 2 : 1,
      permissions: ["microphone"],
      // A touch screen, so the page offers the phone's camera.
      ...(shot.touch ? { hasTouch: true, isMobile: true } : {}),
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
    // Charts size themselves to their column, and a full-page capture that resizes the window
    // mid-shot catches them half redrawn; these pages grow the window first and let them settle.
    if (shot.tall && shot.full !== false) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: shot.width, height });
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: file, fullPage: !shot.tall && !shot.palette && shot.full !== false });
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
