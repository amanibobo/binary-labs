// Asks headless Chromium whether the app is installable. Needs the fixture server on 3100.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
// A persistent profile: Chromium never offers install from an incognito-style context.
const profile = mkdtempSync(join(tmpdir(), "bl-install-"));
const context = await chromium.launchPersistentContext(profile, { headless: true, channel: "chromium" });
try {
  const page = await context.newPage();
  await page.goto(`${base}/dev/fixtures/upload`, { waitUntil: "networkidle" });
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  const { errors } = await cdp.send("Page.getAppManifest");
  process.stdout.write(`installability errors: ${JSON.stringify(installabilityErrors)}\nmanifest errors: ${JSON.stringify(errors)}\n`);
  if (installabilityErrors.length > 0 || errors.length > 0) process.exitCode = 1;
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
