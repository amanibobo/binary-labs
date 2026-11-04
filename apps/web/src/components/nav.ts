export type Section = "search" | "needs-look" | "lab";

export const NAV = [
  { section: "search", href: "/", label: "Search" },
  { section: "needs-look", href: "/needs-a-look", label: "Needs a look" },
  { section: "lab", href: "/lab", label: "Settings" },
] as const satisfies readonly { section: Section; href: string; label: string }[];
