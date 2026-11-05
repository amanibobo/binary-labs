import { z } from "zod";

export const ThemePreference = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

export const THEME_COOKIE = "bl-theme";

// Runs in <head> before the first paint: applies the saved choice, or follows the system and keeps
// following it while the page is open. The theme lives on <html data-theme>.
export const THEME_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark|system)/);var p=m?m[1]:"system";var q=matchMedia("(prefers-color-scheme: dark)");var a=function(){document.documentElement.dataset.theme=p==="system"?(q.matches?"dark":"light"):p};a();q.addEventListener("change",function(){if(p==="system")a()});window.__setTheme=function(n){p=n;document.cookie="${THEME_COOKIE}="+n+";path=/;max-age=31536000;samesite=lax";a()}}catch(e){}})();`;

export function readThemePreference(cookie: string): ThemePreference {
  const match = new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`).exec(cookie);
  const parsed = ThemePreference.safeParse(match?.[1]);
  return parsed.success ? parsed.data : "system";
}
