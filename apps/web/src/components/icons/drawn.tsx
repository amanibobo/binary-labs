import type { ReactNode } from "react";
import type { FileKind } from "@/lib/domain";
import { Svg, type IconProps } from "./svg";

// Glyphs Base Web lacks, drawn on its 24px grid: 1.75px lines with round ends,
// kept inside the same 3 to 21 box its own icons use.

const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const PAGE = "M13 4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9z";
const FOLD = "M13 4v4a1 1 0 0 0 1 1h4";

function Page({ children, ...props }: IconProps & { children?: ReactNode }) {
  return (
    <Svg {...props}>
      <path {...line} d={PAGE} />
      <path {...line} d={FOLD} />
      {children}
    </Svg>
  );
}

export function FileIcon(props: IconProps) {
  return <Page {...props} />;
}

export function FileDocumentIcon(props: IconProps) {
  return (
    <Page {...props}>
      <path {...line} d="M9 13h6M9 16.5h4" />
    </Page>
  );
}

export function FileTextIcon(props: IconProps) {
  return (
    <Page {...props}>
      <path {...line} d="M9.5 12.5h5M12 12.5V17" />
    </Page>
  );
}

export function FileSpreadsheetIcon(props: IconProps) {
  return (
    <Page {...props}>
      <rect x="8.5" y="12" width="3" height="2.5" rx="0.5" />
      <rect x="12.5" y="12" width="3" height="2.5" rx="0.5" />
      <rect x="8.5" y="15.5" width="3" height="2.5" rx="0.5" />
      <rect x="12.5" y="15.5" width="3" height="2.5" rx="0.5" />
    </Page>
  );
}

export function FilePdfIcon(props: IconProps) {
  return (
    <Page {...props}>
      <rect x="8.5" y="12" width="7" height="5" rx="1" />
    </Page>
  );
}

export function FileImageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect {...line} x="4" y="5" width="16" height="14" rx="2" />
      <path {...line} d="m5 17.5 4.5-4.5 3.5 3.5 2-2 3.5 3.5" />
      <circle cx="15.5" cy="9.5" r="1.5" />
    </Svg>
  );
}

// Filled so it takes a folder tint; the tab sits a shade back from the front panel.
export function FolderFilledIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path opacity="0.72" d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.42.59L12 7h7a2 2 0 0 1 2 2v1H3z" />
      <path d="M3 9.5a1.5 1.5 0 0 1 1.5-1.5h15A1.5 1.5 0 0 1 21 9.5V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

export function SearchOutlineIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle {...line} cx="11" cy="11" r="6" />
      <path {...line} d="m15.5 15.5 4 4" />
    </Svg>
  );
}

export function BrowseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M7 5h3l1.5 1.5H18a2 2 0 0 1 2 2V14" />
      <path {...line} d="M4 10a2 2 0 0 1 2-2h3l1.5 1.5H15a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    </Svg>
  );
}

export function NeedsLookIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M4 13.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5M4 13.5 6.2 6.4A2 2 0 0 1 8.1 5h7.8a2 2 0 0 1 1.9 1.4l2.2 7.1M4 13.5h4.5l1 2h5l1-2H20" />
    </Svg>
  );
}

// A clipboard of steps: protocols and tutorials.
export function ProtocolIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M9 5H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect {...line} x="9" y="3.5" width="6" height="3" rx="1" />
      <path {...line} d="M9 11h6M9 14.5h4" />
    </Svg>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
      <circle {...line} cx="15" cy="7" r="2" />
      <circle {...line} cx="9" cy="12" r="2" />
      <circle {...line} cx="17" cy="17" r="2" />
    </Svg>
  );
}

export function ChevronUpDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="m8.5 9.5 3.5-3.5 3.5 3.5M8.5 14.5l3.5 3.5 3.5-3.5" />
    </Svg>
  );
}

export function ChevronSmallIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="m10 7.5 4.5 4.5-4.5 4.5" />
    </Svg>
  );
}

export function SignOutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M14 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7M11 12h9M17 9l3 3-3 3" />
    </Svg>
  );
}

export function OpenExternalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M11 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4M14 5h5v5M19 5l-8 8" />
    </Svg>
  );
}

export const FILE_KIND_ICONS = {
  pdf: FilePdfIcon,
  spreadsheet: FileSpreadsheetIcon,
  document: FileDocumentIcon,
  text: FileTextIcon,
  image: FileImageIcon,
  other: FileIcon,
} satisfies Record<FileKind, (props: IconProps) => ReactNode>;
