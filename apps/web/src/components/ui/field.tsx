import { cva, type VariantProps } from "class-variance-authority";
import { Label as LabelPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// Base Web Input: a gray filled field whose 2px border turns contentPrimary on
// focus, so it needs no separate focus ring.
export const inputVariants = cva(
  "w-full rounded-lg border-2 border-background-secondary bg-background-secondary text-content-primary placeholder:text-content-tertiary transition-colors duration-200 ease-out focus:border-border-selected focus:bg-background-primary focus-visible:outline-none",
  {
    variants: {
      size: {
        compact: "min-h-11 px-3.5 py-1.5 text-paragraph-small sm:min-h-9",
        default: "min-h-12 px-3.5 py-2.5 text-paragraph-medium",
        large: "min-h-15 px-3.5 py-3.5 text-paragraph-large",
      },
    },
    defaultVariants: { size: "default" },
  },
);

type InputProps = Omit<ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>;

export function Input({ className, size, ...props }: InputProps) {
  return <input className={cn(inputVariants({ size }), className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-label-medium text-content-primary", className)} {...props} />;
}

export function Caption({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-paragraph-small text-content-tertiary", className)} {...props} />;
}
