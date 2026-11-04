import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// Base Web Button kinds on a tighter scale than Base: compact 32px, default 40px, large 48px,
// 8px radius. Compact and default grow to 44px on phones for touch.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg whitespace-nowrap transition-colors duration-150 ease-out disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary:
          "bg-button-primary-fill text-content-inverse-primary hover:bg-button-primary-hover disabled:bg-background-secondary disabled:text-content-tertiary",
        secondary:
          "bg-background-secondary text-content-primary hover:bg-button-secondary-hover disabled:bg-background-secondary disabled:text-content-tertiary",
        tertiary: "text-content-primary hover:bg-button-tertiary-hover disabled:bg-transparent disabled:text-content-tertiary",
      },
      size: {
        compact: "min-h-11 px-3 text-label-small sm:min-h-8",
        default: "min-h-11 px-[18px] text-label-medium sm:min-h-10",
        large: "min-h-12 px-6 text-label-medium",
      },
      shape: {
        default: "",
        square: "px-0",
      },
    },
    compoundVariants: [
      { shape: "square", size: "compact", className: "w-11 sm:w-8" },
      { shape: "square", size: "default", className: "w-11 sm:w-10" },
      { shape: "square", size: "large", className: "w-12" },
    ],
    defaultVariants: { variant: "primary", size: "default", shape: "default" },
  },
);

type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, shape, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(buttonVariants({ variant, size, shape }), className)} {...props} />;
}
