"use client";
import { DropdownMenu } from "radix-ui";
import { cn } from "@/lib/cn";
import { CheckIcon, ChevronDownIcon } from "../icons/base-web";
import { DownloadIcon } from "../icons/drawn";
import { Button } from "../ui/button";
import { menuItem, menuSurface } from "../ui/menu";
import { EXPORT_SIZE_KEYS, EXPORT_SIZES, type ExportSize } from "./chart-export";

// The Download menu a chart and a run history share: the size, then PDF, SVG, PNG and the
// numbers as CSV.

export type ExportKind = "pdf" | "svg" | "png" | "csv";

// Download: the figure's size first, then the file. Print sizes are laid out for a journal's
// column with its type at 7 pt; slides at 960 by 560.
export function ExportMenu({
  disabled,
  size,
  onSize,
  onExport,
  csvHelp = "Means, spreads, n, the test, the fit and your samples, unrounded",
}: {
  disabled: boolean;
  size: ExportSize;
  onSize: (size: ExportSize) => void;
  onExport: (kind: ExportKind) => void;
  csvHelp?: string;
}) {
  const print = size !== "slides";
  const item = (kind: ExportKind, title: string, help: string) => (
    <DropdownMenu.Item className={cn(menuItem, "items-start py-2")} onSelect={() => onExport(kind)}>
      <span>
        <span className="block text-label-medium">{title}</span>
        <span className="block text-paragraph-small text-content-tertiary">{help}</span>
      </span>
    </DropdownMenu.Item>
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <Button variant="tertiary" size="compact" className="gap-1.5 text-content-secondary">
          <DownloadIcon className="size-5" />
          <span className="hidden sm:inline">Download</span>
          <span className="sr-only sm:hidden">Download</span>
          <ChevronDownIcon className="-mr-1 hidden size-4 sm:block" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={cn(menuSurface, "w-80")}>
          <p className="px-3 pt-2 pb-1 text-paragraph-xsmall text-content-tertiary">On white, with the title, and the test or fit written under the chart. Type prints at 7 pt.</p>
          <DropdownMenu.Label className="px-3 pt-2 pb-1 text-paragraph-xsmall text-content-tertiary">Size</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={size} onValueChange={(v) => onSize(v === "double" ? "double" : v === "slides" ? "slides" : "column")}>
            {EXPORT_SIZE_KEYS.map((key) => (
              <DropdownMenu.RadioItem key={key} value={key} onSelect={(e) => e.preventDefault()} className={cn(menuItem, "gap-2")}>
                <span className="flex size-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <CheckIcon className="size-4" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {EXPORT_SIZES[key].label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border-opaque" />
          {item("pdf", "PDF", print ? `For a paper, ${EXPORT_SIZES[size].short} wide, sharp at any zoom` : "For slides or a handout")}
          {item("svg", "SVG", "To edit in Illustrator or Inkscape, sharp at any size")}
          {item("png", "PNG picture", print ? `${EXPORT_SIZES[size].short} at 300 dpi` : "For slides, at twice screen size")}
          <DropdownMenu.Separator className="my-1 h-px bg-border-opaque" />
          {item("csv", "The numbers behind it (CSV)", csvHelp)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

