import type { AnswerSource, Citation } from "@/lib/answers";
import { openTarget } from "@/lib/format";
import { newChartHref } from "@/lib/charts";
import { protocolHref } from "@/lib/protocols";

// Where a citation opens: the file itself (or its table), or the protocol at the cited version.
export function citationHref(source: AnswerSource, citation: Citation | null): { href: string; external: boolean } {
  switch (source.kind) {
    case "protocol":
      return { href: protocolHref(source.protocolId, source.version), external: false };
    case "file": {
      if (citation?.cell != null) return { href: newChartHref(source.location.id, undefined, { sheet: citation.cell.table, column: citation.cell.column, row: citation.cell.row }), external: false };
      const open = openTarget(source.location);
      if (open !== null) return { href: open.href, external: source.location.sourceKind === "dropbox" };
      return { href: `/?${new URLSearchParams({ q: source.name, open: source.sha256 })}`, external: false };
    }
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}
