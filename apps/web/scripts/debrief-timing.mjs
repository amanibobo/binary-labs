// Times one full debrief on the fixture page, headless: a typed pass and a spoken pass, from
// Start to "Saved to the run.". The spoken pass has the Mac's `say` speak the six answers in
// src/fixtures/debrief-answers.json into Chrome's fake microphone, and holds each recording
// open for as long as `say` took to speak that answer; the fixture returns the same words as
// the transcript. The typed pass types each answer at TYPE_MS a key. Neither pass includes a
// person's thinking or reading time, so both are estimates until a real scientist is timed.
// Needs macOS and `BINARY_LABS_FIXTURES=1 pnpm exec next dev -p 3100`:
//   BASE_URL=http://localhost:3100 node scripts/debrief-timing.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
// 40 words a minute, about five characters a word: an ordinary typist, not a fast one.
const TYPE_MS = Number(process.env.TYPE_MS ?? 300);
const answers = JSON.parse(readFileSync(join(import.meta.dirname, "../src/fixtures/debrief-answers.json"), "utf8"));
const questions = [1, 2, 3, 4, 5, 6];
const dir = mkdtempSync(join(tmpdir(), "bl-debrief-timing-"));

// Each answer spoken by `say`, as 16 kHz WAV, with how long it takes to say.
function speak(name, text) {
  const aiff = join(dir, `${name}.aiff`);
  const wav = join(dir, `${name}.wav`);
  execFileSync("say", ["-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", aiff, wav]);
  const seconds = Number(/estimated duration: ([\d.]+) sec/.exec(execFileSync("afinfo", [wav], { encoding: "utf8" }))?.[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`no duration for ${wav}`);
  return { wav, ms: Math.round(seconds * 1000) };
}
const spoken = Object.fromEntries(questions.map((q) => [q, speak(`q${q}`, answers[q])]));
const all = speak("all", questions.map((q) => answers[q]).join(" "));

async function pass(kind) {
  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${all.wav}`];
  const browser = await chromium.launch({ headless: true, args });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
  const page = await context.newPage();
  await page.goto(`${base}/dev/fixtures/debrief?view=start`, { waitUntil: "networkidle" });
  const started = Date.now();
  let speaking = 0;
  await page.getByRole("button", { name: "Start" }).click();
  for (const q of questions) {
    await page.getByText(`Question ${q} of 6`).waitFor();
    if (kind === "typed") {
      await page.getByRole("button", { name: "Type instead" }).click();
      await page.getByRole("textbox").click();
      await page.keyboard.type(answers[q], { delay: TYPE_MS });
      if (q === 5) await page.getByRole("button", { name: "Yes", exact: true }).click();
      await page.getByRole("button", { name: "Save answer" }).click();
    } else {
      await page.getByRole("button", { name: "Record your answer" }).click();
      await page.getByRole("button", { name: "Stop" }).waitFor();
      await page.waitForTimeout(spoken[q].ms);
      speaking += spoken[q].ms;
      await page.getByRole("button", { name: "Stop" }).click();
      if (q === 5) await page.getByRole("button", { name: "Yes", exact: true }).click();
      await page.getByRole("button", { name: q === 6 ? "Check your answers" : "Next" }).click();
    }
  }
  await page.getByRole("heading", { name: "Check your answers" }).waitFor();
  const save = page.getByRole("button", { name: "Save to the run" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Save to the run" && !b.disabled));
  await page.getByRole("checkbox", { name: "Use as the run's suspected cause" }).check();
  await save.click();
  await page.getByText("Saved to the run.").waitFor();
  const ms = Date.now() - started;
  await browser.close();
  return { ms, speaking };
}

const chars = questions.reduce((n, q) => n + answers[q].length, 0);
const seconds = (ms) => (ms / 1000).toFixed(1);
const typed = await pass("typed");
const voiced = await pass("spoken");
process.stdout.write(
  [
    `answers: ${chars} characters, ${questions.map((q) => answers[q].split(/\s+/).length).reduce((a, b) => a + b, 0)} words`,
    `typed pass:  ${seconds(typed.ms)} s at ${TYPE_MS} ms a key (typing alone ${seconds(chars * TYPE_MS)} s)`,
    `spoken pass: ${seconds(voiced.ms)} s (speaking ${seconds(voiced.speaking)} s at say's pace, the rest is the screens and waiting for transcripts)`,
    "",
  ].join("\n"),
);
