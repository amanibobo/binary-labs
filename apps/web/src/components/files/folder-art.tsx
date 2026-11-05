import { ShadingDefs, Sheet, useShading } from "@/components/art/kit";
import { cn } from "@/lib/cn";
import { TINT_STYLE, type FolderTint } from "@/lib/tints";

const BACK =
  "M10 30a8 8 0 0 1 8-8h33.5a8 8 0 0 1 6.1 2.83L63 31.2h79a8 8 0 0 1 8 8V104a10 10 0 0 1-10 10H20a10 10 0 0 1-10-10z";
const FRONT = "M6 58a9 9 0 0 1 9-9h130a9 9 0 0 1 9 9v46a12 12 0 0 1-12 12H18A12 12 0 0 1 6 104z";

// An illustrated folder in a tint: back panel, two sheets peeking out, and a
// front panel shaded top to bottom. Vector only, so it stays crisp at any size.
export function FolderArt({ tint: { tint, shade }, className }: { tint: FolderTint; className?: string }) {
  const shading = useShading();
  const fill = shade === "base" ? TINT_STYLE[tint].fill : TINT_STYLE[tint].fillSoft;
  return (
    <svg viewBox="0 0 160 120" aria-hidden focusable="false" className={cn("block h-auto w-full", className)}>
      <ShadingDefs shading={shading} fill={fill} />
      <path d={BACK} fill={shading.back} />
      <Sheet x={22} y={8} rotate={-8} paper={shading.paper} />
      <Sheet x={76} y={6} rotate={7} paper={shading.paper} />
      <path d={FRONT} fill={shading.front} />
      <path d="M16 50.5h128" stroke="white" strokeOpacity="0.4" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
