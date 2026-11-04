"use client";

import { DropdownMenu, Popover } from "radix-ui";
import { useId, type ReactNode } from "react";
import { FILE_KINDS, FileKind, type SearchFilters } from "@/lib/domain";
import { hasFilters } from "@/lib/filters";
import { formatDate, KIND_LABELS } from "@/lib/format";
import { cn } from "@/lib/cn";
import { CheckIcon, ChevronDownIcon } from "../icons/base-web";
import { FILE_KIND_ICONS } from "../icons/drawn";
import { buttonVariants } from "../ui/button";
import { Input, Label } from "../ui/field";
import { menuItem, menuSurface } from "../ui/menu";


const optional = (value: string) => (value === "" ? undefined : value);
const day = (iso: string) => formatDate(`${iso}T00:00:00Z`);

function dateLabel({ from, to }: SearchFilters): string | null {
  if (from !== undefined && to !== undefined) return `${day(from)} to ${day(to)}`;
  if (from !== undefined) return `Since ${day(from)}`;
  if (to !== undefined) return `Until ${day(to)}`;
  return null;
}

// Base Web Tag at its medium size (32px, 24px radius) used as filter chips; a
// set filter fills like a selected Base button. Chips grow to 44px on phones.
function chipClass(active: boolean) {
  return cn(
    "inline-flex min-h-11 max-w-64 shrink-0 items-center gap-1 rounded-3xl pr-2 pl-3 text-label-small transition-colors duration-150 ease-out sm:min-h-8",
    active
      ? "bg-button-primary-fill text-content-inverse-primary hover:bg-button-primary-hover"
      : "bg-background-secondary text-content-primary hover:bg-button-secondary-hover",
  );
}

function ChipLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="truncate">{children}</span>
      <ChevronDownIcon className="size-5 shrink-0" />
    </>
  );
}

export function Filters({ value, onChange }: { value: SearchFilters; onChange: (next: SearchFilters) => void }) {
  const id = useId();
  const dates = dateLabel(value);
  return (
    <div role="group" aria-label="Filters" className="-mx-4 mt-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className={chipClass(value.kind !== undefined)}>
          <ChipLabel>{value.kind === undefined ? "Kind" : KIND_LABELS[value.kind]}</ChipLabel>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={8} className={menuSurface}>
            <DropdownMenu.RadioGroup
              value={value.kind ?? ""}
              onValueChange={(next) => {
                const kind = FileKind.safeParse(next);
                onChange({ ...value, kind: kind.success ? kind.data : undefined });
              }}
            >
              {(["", ...FILE_KINDS] as const).map((kind) => {
                const KindIcon = kind === "" ? null : FILE_KIND_ICONS[kind];
                return (
                  <DropdownMenu.RadioItem key={kind} value={kind} className={menuItem}>
                    {KindIcon === null ? <span className="size-6" /> : <KindIcon className="text-content-secondary" />}
                    <span className="flex-1">{kind === "" ? "Any kind" : KIND_LABELS[kind]}</span>
                    <DropdownMenu.ItemIndicator>
                      <CheckIcon />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                );
              })}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Popover.Root>
        <Popover.Trigger className={chipClass(value.prefix !== undefined)}>
          <ChipLabel>{value.prefix === undefined ? "Folder" : <span className="font-mono">{value.prefix}</span>}</ChipLabel>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={8} className={cn(menuSurface, "grid w-80 max-w-[calc(100vw-32px)] gap-2 p-4")}>
            <Label htmlFor={`${id}-prefix`}>Folder</Label>
            <Input
              id={`${id}-prefix`}
              size="compact"
              className="font-mono"
              placeholder="/Lab/Gels"
              spellCheck={false}
              autoCapitalize="off"
              value={value.prefix ?? ""}
              onChange={(e) => onChange({ ...value, prefix: optional(e.target.value.trim()) })}
            />
            <p className="text-paragraph-small text-content-tertiary">Files whose path starts with this.</p>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Popover.Root>
        <Popover.Trigger className={chipClass(dates !== null)}>
          <ChipLabel>{dates ?? "Modified"}</ChipLabel>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={8} className={cn(menuSurface, "grid w-80 max-w-[calc(100vw-32px)] gap-4 p-4")}>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-from`}>Modified from</Label>
              <Input
                id={`${id}-from`}
                type="date"
                size="compact"
                value={value.from ?? ""}
                max={value.to}
                onChange={(e) => onChange({ ...value, from: optional(e.target.value) })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-to`}>To</Label>
              <Input
                id={`${id}-to`}
                type="date"
                size="compact"
                value={value.to ?? ""}
                min={value.from}
                onChange={(e) => onChange({ ...value, to: optional(e.target.value) })}
              />
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {hasFilters(value) ? (
        <button
          type="button"
          onClick={() => onChange({})}
          className={cn(buttonVariants({ variant: "tertiary", size: "compact" }), "shrink-0 sm:min-h-8")}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
