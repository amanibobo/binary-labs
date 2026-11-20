import type { ReactNode } from "react";
import type { FolderPath } from "@/lib/folders";
import type { IconProps } from "./icons/svg";
import { CalendarIcon } from "./icons/calendar";
import { BrowseIcon, FlagIcon, MapIcon, NeedsLookIcon, ProtocolIcon, RunIcon, SearchOutlineIcon, SettingsIcon, UploadIcon } from "./icons/drawn";

export type Section = "search" | "browse" | "runs" | "protocols" | "map" | "calendar" | "needs-look" | "flags" | "upload" | "lab";

export type ShellLocation = { section: Section; folder?: FolderPath };

export type NavItem = { section: Section; href: string; label: string; Icon: (props: IconProps) => ReactNode };

// The sidebar's main list; Settings sits apart at the foot, beside the account.
export const NAV = [
  { section: "search", href: "/", label: "Search", Icon: SearchOutlineIcon },
  { section: "browse", href: "/browse", label: "Browse", Icon: BrowseIcon },
  { section: "runs", href: "/runs", label: "Runs", Icon: RunIcon },
  { section: "protocols", href: "/protocols", label: "Protocols", Icon: ProtocolIcon },
  { section: "map", href: "/map", label: "Map", Icon: MapIcon },
  { section: "calendar", href: "/calendar", label: "Calendar", Icon: CalendarIcon },
  { section: "needs-look", href: "/needs-a-look", label: "Needs a look", Icon: NeedsLookIcon },
  { section: "flags", href: "/flags", label: "Flags", Icon: FlagIcon },
  { section: "upload", href: "/upload", label: "Upload", Icon: UploadIcon },
] as const satisfies readonly NavItem[];

export const SETTINGS_NAV = { section: "lab", href: "/settings", label: "Settings", Icon: SettingsIcon } as const satisfies NavItem;

// The desktop sidebar's folded state, kept per browser so the server renders the right width.
export const SIDEBAR_COOKIE = "bl-sidebar";
