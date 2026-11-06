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

// Three dots joined by thin lines: the lab map.
export function MapIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="m8.2 8.6 7.6-2.2M7.6 9.7l3.3 6.6M16.6 7.8l-3.6 8.4" />
      <circle {...line} cx="6.5" cy="9" r="2" />
      <circle {...line} cx="17.5" cy="6" r="2" />
      <circle {...line} cx="12" cy="18" r="2" />
    </Svg>
  );
}

// Axes with a line rising across them: a chart of a data sheet.
export function ChartIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M4.5 4.5V18a1.5 1.5 0 0 0 1.5 1.5h13.5" />
      <path {...line} d="m8 15 3.5-4 3 2.5L19 8" />
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

export function SidebarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect {...line} x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path {...line} d="M9.5 4.5v15" />
    </Svg>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z" />
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


export function ChevronSmallIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="m10 7.5 4.5 4.5-4.5 4.5" />
    </Svg>
  );
}

// Dropbox's own glyph (Simple Icons, CC0) in Dropbox blue, for the Dropbox connection.
export function DropboxLogo(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        fill="#0061FF"
        d="M6 1.807 0 5.629l6 3.822 6.001-3.822zm12 0-6 3.822 6 3.822 6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452zm18-3.822-6 3.822 6 3.822 6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822z"
      />
    </Svg>
  );
}

// A benchtop instrument with its drawer out.
export function InstrumentIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8H4zM4 15v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M8 15v2.5h6V15M15.5 9h1.5" />
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

export function FilterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M5 7h14M7.5 12h9M10 17h4" />
    </Svg>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </Svg>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M4 9a2 2 0 0 1 2-2h2l1.5-2h5L16 7h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <circle {...line} cx="12" cy="13" r="3.25" />
    </Svg>
  );
}

export function FileAudioIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M12 4v16M8 8v8M16 7v10M4 11v2M20 10v4" />
    </Svg>
  );
}

export function FileVideoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect {...line} x="3.5" y="6" width="12" height="12" rx="2" />
      <path {...line} d="m15.5 10.5 5-3v9l-5-3" />
    </Svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect {...line} x="9" y="3.5" width="6" height="11" rx="3" />
      <path {...line} d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
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
  audio: FileAudioIcon,
  video: FileVideoIcon,
} satisfies Record<FileKind, (props: IconProps) => ReactNode>;

// The help button's ⓘ.
export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle {...line} cx="12" cy="12" r="8.5" />
      <path {...line} d="M12 11v5" />
      <circle cx="12" cy="8" r="1.1" />
    </Svg>
  );
}

// A pennant on a pole: a flag raised against a protocol's check.
export function FlagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M6 20.5V4" />
      <path {...line} d="M6 4.5h10.2a.8.8 0 0 1 .6 1.3L14.5 9l2.3 3.2a.8.8 0 0 1-.6 1.3H6" />
    </Svg>
  );
}

// A checklist line: an open ring, filled with a tick once it's done.
export function ChecklistMarkIcon({ done, ...props }: IconProps & { done: boolean }) {
  return (
    <Svg {...props}>
      {done ? (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path fill="none" stroke="var(--content-inverse-primary)" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" d="m8.5 12.2 2.4 2.3 4.6-4.8" />
        </>
      ) : (
        <circle {...line} cx="12" cy="12" r="8.5" />
      )}
    </Svg>
  );
}
