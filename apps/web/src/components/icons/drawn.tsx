import type { ReactNode } from "react";
import type { FileKind } from "@/lib/domain";
import { Svg, type IconProps } from "./svg";

// Glyphs Base Web lacks, drawn on its 24px grid: 2px lines with round ends,
// kept inside the same 3 to 21 box its own icons use.

const line = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

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

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path {...line} d="M4 8a2 2 0 0 1 2-2h3.5l2 2H18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
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
