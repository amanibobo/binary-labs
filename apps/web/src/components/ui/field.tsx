import { cva, type VariantProps } from "class-variance-authority";
import { Label as LabelPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// A filled field with a hairline edge that turns blue on focus, standing in for the focus ring.
export const inputVariants = cva(
  "w-full rounded-control border border-border-opaque bg-background-secondary text-content-primary placeholder:text-content-tertiary transition-colors duration-150 ease-out focus:border-border-accent focus:ring-1 focus:ring-border-accent focus-visible:outline-none",
  {
    variants: {
      size: {
        compact: "min-h-11 px-3 py-1.5 text-paragraph-small sm:min-h-8",
        default: "min-h-11 px-3.5 py-2 text-paragraph-medium sm:min-h-10",
        large: "min-h-12 px-4 py-3 text-paragraph-large sm:min-h-14",
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
