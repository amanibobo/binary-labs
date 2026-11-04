import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export type IconProps = Omit<ComponentProps<"svg">, "viewBox" | "children">;

export function Svg({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable="false"
      className={cn("size-6 shrink-0", className)}
      {...props}
    />
  );
}
