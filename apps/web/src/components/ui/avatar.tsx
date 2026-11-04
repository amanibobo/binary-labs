import { cn } from "@/lib/cn";
import { TINT_STYLE, tintFor } from "@/lib/tints";

const SIZES = { small: "size-6 text-label-xsmall", medium: "size-8 text-label-small" } as const;

// An initial on a tint picked from `tintKey` (an email for people), so one person keeps one color everywhere.
export function Avatar({
  label,
  tintKey = label,
  size = "medium",
  className,
}: {
  label: string;
  tintKey?: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium",
        SIZES[size],
        TINT_STYLE[tintFor(tintKey)].avatar,
        className,
      )}
    >
      {label.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
