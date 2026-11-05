import type { ReactNode } from "react";
import type { FolderPath } from "@/lib/folders";
import type { IconProps } from "./icons/svg";
import { BrowseIcon, NeedsLookIcon, ProtocolIcon, SearchOutlineIcon, SettingsIcon, UploadIcon } from "./icons/drawn";

export type Section = "search" | "browse" | "protocols" | "needs-look" | "upload" | "lab";

export type ShellLocation = { section: Section; folder?: FolderPath };

export type NavItem = { section: Section; href: string; label: string; Icon: (props: IconProps) => ReactNode };

// The sidebar's main list; Settings sits apart at the foot, beside the account.
export const NAV = [
  { section: "search", href: "/", label: "Search", Icon: SearchOutlineIcon },
  { section: "browse", href: "/browse", label: "Browse", Icon: BrowseIcon },
  { section: "protocols", href: "/protocols", label: "Protocols", Icon: ProtocolIcon },
  { section: "needs-look", href: "/needs-a-look", label: "Needs a look", Icon: NeedsLookIcon },
  { section: "upload", href: "/upload", label: "Upload", Icon: UploadIcon },
] as const satisfies readonly NavItem[];

export const SETTINGS_NAV = { section: "lab", href: "/lab", label: "Settings", Icon: SettingsIcon } as const satisfies NavItem;
