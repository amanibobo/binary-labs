import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { LogoMark } from "./logo";
import { dataSurface } from "./ui/data-table";

// Sign-in and lab creation: one raised card centered on the ground, the product name above it.
export function CenteredCard({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background-sidebar px-4 py-16">
      <p className="mb-6 flex items-center gap-2.5 text-label-large text-content-primary">
        <LogoMark className="h-6 w-auto" />
        Binary
      </p>
      <div className={cn(dataSurface, "w-full max-w-[420px] p-6 sm:p-8")}>
        <h1 className="text-heading-small">{title}</h1>
        <p className="mt-2 mb-6 text-paragraph-medium text-content-tertiary">{description}</p>
        {children}
      </div>
    </main>
  );
}
