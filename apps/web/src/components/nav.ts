export type Section = "search" | "lab";

export const NAV = [
  { section: "search", href: "/", label: "Search" },
  { section: "lab", href: "/lab", label: "Settings" },
] as const satisfies readonly { section: Section; href: string; label: string }[];
