import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PALETTE, SERIES_COLORS } from "@/lib/charts";
import { EXPORT_INK } from "../chart-svg";

const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
const [lightCss, darkCss] = css.split(':root[data-theme="dark"]');
const tokens = (block: string) => new Map([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
const light = tokens(lightCss);
const dark = tokens(darkCss.slice(0, darkCss.indexOf("@theme")));

describe("chart colors", () => {
  it.each(SERIES_COLORS)("--chart-%s is the palette's step in each theme", (slot) => {
    expect(light.get(`chart-${slot}`)).toBe(PALETTE[slot].light);
    expect(dark.get(`chart-${slot}`)).toBe(PALETTE[slot].dark);
  });

  it("exports in the light theme's chart ink", () => {
    expect(EXPORT_INK.grid).toBe(light.get("border-opaque"));
    expect(EXPORT_INK.axis).toBe(light.get("border-raised"));
    expect(EXPORT_INK.tick).toBe(light.get("content-tertiary"));
    expect(EXPORT_INK.label).toBe(light.get("content-secondary"));
    expect(EXPORT_INK.title).toBe(light.get("content-primary"));
    expect(EXPORT_INK.flag).toBe(light.get("chart-flag"));
    expect(EXPORT_INK.series.muted).toBe(light.get("content-tertiary"));
  });
});
