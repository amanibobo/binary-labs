import { cn } from "@/lib/cn";

// A tertiary block with a secondary shimmer.
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-skeleton rounded-lg bg-[linear-gradient(135deg,var(--background-tertiary)_40%,var(--background-secondary)_50%,var(--background-tertiary)_60%)] bg-size-[400%_100%]",
        className,
      )}
    />
  );
}
