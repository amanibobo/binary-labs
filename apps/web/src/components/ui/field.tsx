import { Label as LabelPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const controlClass =
  "min-h-11 w-full rounded-control border border-hairline bg-surface px-3 text-[15px] text-ink placeholder:text-muted/80 transition-colors duration-150 ease-out hover:border-ink/30 focus-visible:outline-offset-[-1px]";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-sm font-medium text-ink", className)} {...props} />;
}
