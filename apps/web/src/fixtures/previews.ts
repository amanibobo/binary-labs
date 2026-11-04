// Small drawn stand-ins for worker previews (a gel photo, a PDF page) so
// fixture screenshots show real image layout without any stored files.

const gel = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
<rect width="480" height="320" fill="#1d2326"/>
${[0, 1, 2, 3, 4, 5, 6, 7]
  .map((i) => {
    const x = 36 + i * 54;
    const bands = i === 0 ? [60, 92, 130, 175, 230, 270] : [110 + (i % 3) * 6, 168, 214 - (i % 2) * 8];
    return bands
      .map((y, j) => `<rect x="${x}" y="${y}" width="40" height="${i === 0 ? 4 : 7}" rx="3" fill="#e9eee8" opacity="${i === 0 ? 0.55 : 0.9 - j * 0.22}"/>`)
      .join("");
  })
  .join("")}
</svg>`;

const page = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="460" viewBox="0 0 360 460">
<rect width="360" height="460" fill="#fbfbf9"/>
<rect x="36" y="40" width="190" height="12" rx="2" fill="#2b3a3d"/>
${Array.from({ length: 14 }, (_, i) => `<rect x="36" y="${76 + i * 18}" width="${i % 5 === 4 ? 180 : 288}" height="6" rx="2" fill="#9aa5a6"/>`).join("")}
<rect x="36" y="346" width="288" height="78" rx="4" fill="none" stroke="#9aa5a6"/>
<polyline points="44,410 90,404 130,380 160,356 182,398 220,404 316,408" fill="none" stroke="#2b3a3d" stroke-width="2"/>
</svg>`;

const plate = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
<rect width="480" height="320" fill="#d9dcd6"/>
<rect x="40" y="40" width="400" height="240" rx="14" fill="#f4f5f2"/>
${Array.from({ length: 48 }, (_, i) => `<circle cx="${78 + (i % 8) * 46}" cy="${78 + Math.floor(i / 8) * 34}" r="12" fill="#1f6b5c" opacity="${0.15 + ((i * 37) % 70) / 100}"/>`).join("")}
</svg>`;

const toUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const PREVIEW_BY_FIRST_CHAR: Record<string, string> = { a: toUri(gel), b: toUri(page), "2": toUri(plate), c: toUri(gel) };
