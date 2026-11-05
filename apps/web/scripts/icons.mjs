// Draws the app icons (the square B on the dark ground) into public/icons from src/lib/logo.json.
// Rerun after changing the logo.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import logo from "../src/lib/logo.json" with { type: "json" };

const out = join(import.meta.dirname, "../public/icons");
mkdirSync(out, { recursive: true });

const GROUND = "#151516";
const INK = "#ececee";

// `glyph` is the share of the square the mark's height spans; maskable icons keep it inside
// the central 80% safe zone that launchers never crop.
function art(size, glyph) {
  const step = logo.cell + logo.gap;
  const w = logo.rows[0].length * step - logo.gap;
  const h = logo.rows.length * step - logo.gap;
  const scale = (size * glyph) / h;
  const x0 = (size - w * scale) / 2;
  const y0 = (size - h * scale) / 2;
  const last = logo.rows.length - 1;
  const rects = logo.rows.flatMap((row, y) =>
    [...row].flatMap((c, x) => {
      if (c !== "X") return [];
      const fill = x === 0 && y === last ? logo.green : x === 0 && y === last - 1 ? logo.blue : INK;
      return [
        `<rect x="${x0 + x * step * scale}" y="${y0 + y * step * scale}" width="${logo.cell * scale}" height="${logo.cell * scale}" rx="${logo.radius * scale}" fill="${fill}"/>`,
      ];
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="${GROUND}"/>${rects.join("")}
</svg>`;
}

const icons = [
  { file: "icon-192.png", size: 192, glyph: 0.62 },
  { file: "icon-512.png", size: 512, glyph: 0.62 },
  { file: "maskable-512.png", size: 512, glyph: 0.5 },
  { file: "apple-touch-icon.png", size: 180, glyph: 0.6 },
];

const browser = await chromium.launch({ headless: true, channel: "chromium", executablePath: process.env.CHROMIUM_PATH });
try {
  for (const { file, size, glyph } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<body style="margin:0">${art(size, glyph)}</body>`);
    writeFileSync(join(out, file), await page.screenshot({ omitBackground: false }));
    await page.close();
    process.stdout.write(`${join(out, file)}\n`);
  }
} finally {
  await browser.close();
}
