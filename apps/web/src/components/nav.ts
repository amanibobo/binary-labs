import type { ReactNode } from "react";
import type { IconProps } from "./icons/svg";
import { BrowseIcon, NeedsLookIcon, ProtocolIcon, SearchOutlineIcon, SettingsIcon } from "./icons/drawn";

export type Section = "search" | "browse" | "protocols" | "needs-look" | "lab";

export const NAV = [
  { section: "search", href: "/", label: "Search", Icon: SearchOutlineIcon },
  { section: "browse", href: "/browse", label: "Browse", Icon: BrowseIcon },
  { section: "protocols", href: "/protocols", label: "Protocols", Icon: ProtocolIcon },
  { section: "needs-look", href: "/needs-a-look", label: "Needs a look", Icon: NeedsLookIcon },
  { section: "lab", href: "/lab", label: "Settings", Icon: SettingsIcon },
] as const satisfies readonly { section: Section; href: string; label: string; Icon: (props: IconProps) => ReactNode }[];
