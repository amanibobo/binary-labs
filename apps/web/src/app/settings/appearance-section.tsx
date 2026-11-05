"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { readThemePreference, type ThemePreference } from "@/lib/theme";

declare global {
  interface Window {
    __setTheme?: (preference: ThemePreference) => void;
  }
}

// The saved choice lives in a cookie; components read it as an external store so a pick shows at once.
const CHANGED = "bl-theme-change";
const subscribe = (onChange: () => void) => {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
};
const useThemeChoice = () =>
  useSyncExternalStore<ThemePreference | null>(subscribe, () => readThemePreference(document.cookie), () => null);

const OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Same as device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// A tiny window drawn in the scheme it stands for; "Same as device" is split down the middle.
function Swatch({ value }: { value: ThemePreference }) {
  const window = (ground: string, bar: string, line: string) => (
    <>
      <rect width="96" height="60" rx="6" fill={ground} />
      <rect x="0" y="0" width="24" height="60" rx="6" fill={bar} />
      <rect x="32" y="12" width="48" height="6" rx="3" fill={line} />
      <rect x="32" y="26" width="36" height="5" rx="2.5" fill={line} opacity="0.6" />
      <rect x="32" y="38" width="42" height="5" rx="2.5" fill={line} opacity="0.6" />
    </>
  );
  const light = window("#ffffff", "#f4f4f5", "#c9c9cf");
  const dark = window("#151516", "#0f0f10", "#3a3a40");
  return (
    <svg viewBox="0 0 96 60" aria-hidden className="block h-auto w-full overflow-hidden rounded-md border border-border-opaque">
      {value === "light" ? light : value === "dark" ? dark : null}
      {value === "system" ? (
        <>
          <clipPath id="swatch-left">
            <rect width="48" height="60" />
          </clipPath>
          <clipPath id="swatch-right">
            <rect x="48" width="48" height="60" />
          </clipPath>
          <g clipPath="url(#swatch-left)">{light}</g>
          <g clipPath="url(#swatch-right)">{dark}</g>
        </>
      ) : null}
    </svg>
  );
}

export function AppearanceSection() {
  const choice = useThemeChoice();
  const pick = (value: ThemePreference) => {
    window.__setTheme?.(value);
    window.dispatchEvent(new Event(CHANGED));
  };

  return (
    <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-3 sm:gap-4">
      {OPTIONS.map(({ value, label }) => {
        const selected = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => pick(value)}
            className={cn(
              "flex min-h-11 flex-col gap-2.5 rounded-xl border p-2.5 text-left transition-colors duration-150 ease-out sm:p-3",
              selected ? "border-border-selected bg-background-secondary" : "border-border-opaque hover:bg-background-secondary",
            )}
          >
            <Swatch value={value} />
            <span className={cn("text-label-medium", selected ? "text-content-primary" : "text-content-secondary")}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
