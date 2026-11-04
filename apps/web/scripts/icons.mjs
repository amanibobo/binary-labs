// Draws the app icons (a 1 and a 0 on the dark ground) into public/icons. Rerun after changing the art.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = join(import.meta.dirname, "../public/icons");
mkdirSync(out, { recursive: true });

const GROUND = "#151516";
const INK = "#f2f2f2";

// `glyph` is the share of the square the mark spans; maskable icons keep it inside the
// central 80% safe zone that launchers never crop.
function art(size, glyph) {
  const g = size * glyph;
  const x0 = (size - g) / 2;
  const y0 = (size - g * 0.8) / 2;
  const stroke = g * 0.11;
  const h = g * 0.8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="${GROUND}"/>
<path d="M${x0 + g * 0.12} ${y0 + h * 0.16} L${x0 + g * 0.27} ${y0 + stroke / 2} V${y0 + h - stroke / 2}" fill="none" stroke="${INK}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="${x0 + g * 0.5}" y="${y0 + stroke / 2}" width="${g * 0.44}" height="${h - stroke}" rx="${g * 0.22}" fill="none" stroke="${INK}" stroke-width="${stroke}"/>
</svg>`;
}

const icons = [
  { file: "icon-192.png", size: 192, glyph: 0.62 },
  { file: "icon-512.png", size: 512, glyph: 0.62 },
  { file: "maskable-512.png", size: 512, glyph: 0.5 },
  { file: "apple-touch-icon.png", size: 180, glyph: 0.6 },
];

const browser = await chromium.launch({ headless: true, channel: "chromium" });
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
