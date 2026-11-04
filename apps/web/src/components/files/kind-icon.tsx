import type { FileKind } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { KIND_TINT, TINT_STYLE } from "@/lib/tints";
import { FILE_KIND_ICONS } from "../icons/drawn";

export function KindIcon({ kind, className }: { kind: FileKind; className?: string }) {
  const Icon = FILE_KIND_ICONS[kind];
  return <Icon className={cn(TINT_STYLE[KIND_TINT[kind]].icon, className)} />;
}
