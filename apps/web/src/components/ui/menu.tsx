// Base Web Menu and Popover: an 8px-radius surface on backgroundPrimary with a
// shallow shadow; options highlight to backgroundSecondary. The ring keeps the
// edge visible in dark mode, where the surface matches the page.
export const menuSurface =
  "z-50 min-w-56 overflow-hidden rounded-lg bg-background-primary py-2 text-content-primary shadow-shallow-below ring-1 ring-border-opaque";

export const menuItem =
  "flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 text-left text-paragraph-medium outline-none select-none data-[highlighted]:bg-background-secondary";
