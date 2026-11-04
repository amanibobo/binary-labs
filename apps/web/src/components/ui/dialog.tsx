import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { DeleteIcon } from "../icons/base-web";
import { buttonVariants } from "./button";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

// A raised 16px-radius dialog with a heading, a dismiss button and a dock of
// full-width actions. Below 640px it becomes a sheet that rises from the bottom edge.
export function DialogContent({
  title,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> & { title: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-background-overlay" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-card border-t border-border-raised bg-background-raised text-content-primary focus-visible:outline-none",
          "sm:inset-x-auto sm:top-10 sm:bottom-auto sm:left-1/2 sm:max-h-[calc(100dvh-80px)] sm:w-[min(640px,calc(100vw-80px))] sm:-translate-x-1/2 sm:rounded-card sm:border sm:shadow-deep-below",
          className,
        )}
        {...props}
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-12 shrink-0 rounded-full bg-background-tertiary sm:hidden" />
        <div className="flex shrink-0 items-start gap-4 pt-4 pr-2 pl-4 sm:pt-6 sm:pl-6">
          <DialogPrimitive.Title className="min-w-0 flex-1 pt-1.5 text-heading-small sm:pt-0.5">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close
            className={cn(buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }), "-mt-1 sm:mt-[-6px] sm:mr-2")}
          >
            <DeleteIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogDock({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 flex-col gap-2 p-4 sm:px-6 sm:pb-6", className)} {...props} />;
}
