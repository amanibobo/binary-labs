// Measures an opened search row in the fixture app, headless: its height and what it holds
// (controls, chips, boxes), at rest and, when it has one, with Edit labels open.
//   BASE_URL=http://localhost:3471 CHROMIUM_PATH=... node scripts/measure-open-row.mjs
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const rows = [
  { label: "Plate 7 data sheet", path: "/dev/fixtures/ask?view=home", name: "Plate 7 absorbance at 420 nm" },
  { label: "Batch 3 gel image", path: "/dev/fixtures/search?state=results&q=p450%20gels", name: "Batch 3 SDS-PAGE gel" },
];

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" }),
});
try {
  for (const width of [1440, 390]) {
    for (const row of rows) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.goto(base + row.path, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: `Details for ${row.name}` }).first().dispatchEvent("click");
      await page.waitForTimeout(900);
      const measure = () =>
        page.evaluate((name) => {
          const toggle = [...document.querySelectorAll("[data-row-toggle]")].find((b) => b.textContent.includes(`Details for ${name}`));
          const li = toggle.closest("li");
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.opacity !== "0";
          };
          const all = [...li.querySelectorAll("*")].filter(visible);
          const controls = all.filter((el) => el.matches("a, button:not([data-row-toggle]), input, select, textarea")).length;
          const boxes = all.filter((el) => {
            const s = getComputedStyle(el);
            const fill = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent";
            const border = parseFloat(s.borderTopWidth) > 0 || s.boxShadow.includes("inset");
            return (fill || border) && el.tagName !== "LI";
          }).length;
          const words = li.innerText.split(/\s+/).filter(Boolean).length;
          return { height: Math.round(li.getBoundingClientRect().height), controls, boxes, words };
        }, row.name);
      const rest = await measure();
      let edit = null;
      const editButton = page.getByRole("button", { name: /^Edit( labels)?$/ }).first();
      if ((await editButton.count()) > 0) {
        await editButton.click();
        await page.waitForTimeout(300);
        edit = await measure();
      }
      process.stdout.write(`${width} ${row.label}: rest ${JSON.stringify(rest)}${edit ? `, editing ${JSON.stringify(edit)}` : ""}\n`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
