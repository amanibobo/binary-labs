import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
const [lightCss, darkCss] = css.split(':root[data-theme="dark"]');

function hexTokens(block: string): Map<string, string> {
  return new Map([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
}

const light = hexTokens(lightCss);
const dark = new Map([...light, ...hexTokens(darkCss.slice(0, darkCss.indexOf("@theme")))]);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Every text color the UI puts on each surface, plus the non-text focus indicators.
type Pair = readonly [fg: string, bg: string];

const SURFACES = ["background-sidebar", "background-primary", "background-raised", "background-secondary"];
const TINTS = ["purple", "blue", "yellow", "orange", "green", "gray"];

const TEXT_PAIRS: Pair[] = [
  ...["content-primary", "content-secondary", "content-tertiary"].flatMap((fg) => SURFACES.map((bg): Pair => [fg, bg])),
  ["content-primary", "background-tertiary"],
  ["content-secondary", "background-tertiary"],
  ["content-primary", "button-secondary-hover"],
  ["content-primary", "button-tertiary-hover"],
  ["content-tertiary", "button-tertiary-hover"],
  ["content-accent", "background-primary"],
  ["content-accent", "background-raised"],
  ["tag-blue-content-secondary", "tag-blue-background-secondary"],
  ["content-warning", "background-warning"],
  ["content-inverse-primary", "button-primary-fill"],
  ["content-inverse-primary", "button-primary-hover"],
  ["content-inverse-primary", "background-inverse-secondary"],
  ...TINTS.map((tint): Pair => [`tint-${tint}-ink`, `tint-${tint}-wash`]),
];

const INDICATOR_PAIRS: Pair[] = SURFACES.map((bg): Pair => ["border-accent", bg]);

describe.each([
  ["light", light],
  ["dark", dark],
])("%s tokens", (_scheme, tokens) => {
  const color = (name: string) => {
    const value = tokens.get(name);
    if (value === undefined) throw new Error(`--${name} is not a hex token in globals.css`);
    return value;
  };

  it.each(TEXT_PAIRS)("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(INDICATOR_PAIRS)("%s on %s is at least 3:1", (fg, bg) => {
    expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(3);
  });
});
