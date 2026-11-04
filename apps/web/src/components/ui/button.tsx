import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// Base Web Button: kinds primary, secondary and tertiary; sizes compact (36px),
// default (48px) and large (56px); 8px radius. Compact grows to 44px on phones.
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
        compact: "min-h-11 px-3 text-label-small sm:min-h-9",
        default: "min-h-12 px-4 text-label-medium",
        large: "min-h-14 px-5 text-label-large",
      },
      shape: {
        default: "",
        square: "px-0",
      },
    },
    compoundVariants: [
      { shape: "square", size: "compact", className: "w-11 sm:w-9" },
      { shape: "square", size: "default", className: "w-12" },
      { shape: "square", size: "large", className: "w-14" },
    ],
    defaultVariants: { variant: "primary", size: "default", shape: "default" },
  },
);

type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, shape, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(buttonVariants({ variant, size, shape }), className)} {...props} />;
}
