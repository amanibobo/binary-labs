"use client";

import { DropdownMenu, Popover } from "radix-ui";
import { useId, type ReactNode } from "react";
import { FILE_KINDS, FileKind, LabelOutcome, type SearchFilters } from "@/lib/domain";
import { hasFilters } from "@/lib/filters";
import { formatDay, KIND_LABELS } from "@/lib/format";
import { OUTCOME_FILTER_NAMES } from "@/lib/row-summary";
import { cn } from "@/lib/cn";
import { CheckIcon, ChevronDownIcon, DeleteIcon } from "../icons/base-web";
import { FilterIcon } from "../icons/drawn";
import { KindIcon } from "../files/kind-icon";
import { buttonVariants } from "../ui/button";
import { Input, Label } from "../ui/field";
import { menuItem, menuSurface } from "../ui/menu";

const optional = (value: string) => (value === "" ? undefined : value);
const day = formatDay;

function dateLabel({ from, to }: SearchFilters): string | null {
  if (from !== undefined && to !== undefined) return `${day(from)} to ${day(to)}`;
  if (from !== undefined) return `Since ${day(from)}`;
  if (to !== undefined) return `Until ${day(to)}`;
  return null;
}

// Sits inside the search box. Icon only on phones, where it is still a 44px target.
export function FiltersToggle({ open, onToggle, controls }: { open: boolean; onToggle: () => void; controls: string }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        buttonVariants({ variant: "tertiary", size: "compact" }),
        "min-w-11 px-2.5 text-content-secondary hover:text-content-primary sm:min-h-10",
        open && "bg-button-secondary-hover text-content-primary",
      )}
    >
      <FilterIcon className="size-5" />
      <span className="max-sm:sr-only">Filters</span>
    </button>
  );
}

// Open: one line of text menus. Closed: only the filters that are set, each removable.
export function Filters({ id, open, value, onChange }: { id: string; open: boolean; value: SearchFilters; onChange: (next: SearchFilters) => void }) {
  if (open) return <FilterMenus id={id} value={value} onChange={onChange} />;
  if (!hasFilters(value)) return <div id={id} hidden />;
  const dates = dateLabel(value);
  return (
    <div id={id} role="group" aria-label="Filters" className="mt-3 flex flex-wrap items-center gap-2">
      {value.kind === undefined ? null : (
        <Chip text={KIND_LABELS[value.kind]} onRemove={() => onChange({ ...value, kind: undefined })} />
      )}
      {value.prefix === undefined ? null : (
        <Chip text={value.prefix} mono onRemove={() => onChange({ ...value, prefix: undefined })} />
      )}
      {dates === null ? null : <Chip text={dates} onRemove={() => onChange({ ...value, from: undefined, to: undefined })} />}
      {value.outcome === undefined ? null : (
        <Chip text={OUTCOME_FILTER_NAMES[value.outcome]} onRemove={() => onChange({ ...value, outcome: undefined })} />
      )}
      {value.check === undefined ? null : <Chip text="Check this" onRemove={() => onChange({ ...value, check: undefined })} />}
    </div>
  );
}

function Chip({ text, mono = false, onRemove }: { text: string; mono?: boolean; onRemove: () => void }) {
  return (
    <span className="inline-flex h-8 max-w-72 items-center gap-0.5 rounded-full bg-background-secondary pr-1 pl-3 text-label-small text-content-primary">
      <span className={cn("truncate", mono && "font-mono")}>{text}</span>
      <button
        type="button"
        onClick={onRemove}
        className="relative grid size-6 shrink-0 place-items-center rounded-full text-content-tertiary transition-colors duration-150 ease-out after:absolute after:-inset-2.5 hover:bg-button-secondary-hover hover:text-content-primary"
      >
        <DeleteIcon className="size-4" />
        <span className="sr-only">Remove filter {text}</span>
      </button>
    </span>
  );
}

function menuTrigger(active: boolean) {
  return cn(
    buttonVariants({ variant: "tertiary", size: "compact" }),
    "max-w-64 gap-1 pr-1.5 pl-2.5",
    active ? "text-content-primary" : "text-content-secondary hover:text-content-primary",
  );
}

function TriggerLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="truncate">{children}</span>
      <ChevronDownIcon className="size-5 shrink-0 text-content-tertiary" />
    </>
  );
}

function FilterMenus({ id, value, onChange }: { id: string; value: SearchFilters; onChange: (next: SearchFilters) => void }) {
  const fieldId = useId();
  const dates = dateLabel(value);
  return (
    <div id={id} role="group" aria-label="Filters" className="mt-2 -ml-2.5 flex flex-wrap items-center gap-x-1">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className={menuTrigger(value.kind !== undefined)}>
          <TriggerLabel>{value.kind === undefined ? "Any kind" : KIND_LABELS[value.kind]}</TriggerLabel>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} className={menuSurface}>
            <DropdownMenu.RadioGroup
              value={value.kind ?? ""}
              onValueChange={(next) => {
                const kind = FileKind.safeParse(next);
                onChange({ ...value, kind: kind.success ? kind.data : undefined });
              }}
            >
              {(["", ...FILE_KINDS] as const).map((kind) => (
                <DropdownMenu.RadioItem key={kind} value={kind} className={menuItem}>
                  {kind === "" ? <span className="size-5" /> : <KindIcon kind={kind} className="size-5" />}
                  <span className="flex-1">{kind === "" ? "Any kind" : KIND_LABELS[kind]}</span>
                  <DropdownMenu.ItemIndicator>
                    <CheckIcon />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Popover.Root>
        <Popover.Trigger className={menuTrigger(value.prefix !== undefined)}>
          <TriggerLabel>{value.prefix === undefined ? "Any folder" : <span className="font-mono">{value.prefix}</span>}</TriggerLabel>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} className={cn(menuSurface, "grid w-80 max-w-[calc(100vw-32px)] gap-2 p-4")}>
            <Label htmlFor={`${fieldId}-prefix`}>Folder</Label>
            <Input
              id={`${fieldId}-prefix`}
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
        <Popover.Trigger className={menuTrigger(dates !== null)}>
          <TriggerLabel>{dates ?? "Any time"}</TriggerLabel>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} className={cn(menuSurface, "grid w-80 max-w-[calc(100vw-32px)] gap-4 p-4")}>
            <div className="grid gap-2">
              <Label htmlFor={`${fieldId}-from`}>Modified from</Label>
              <Input
                id={`${fieldId}-from`}
                type="date"
                size="compact"
                value={value.from ?? ""}
                max={value.to}
                onChange={(e) => onChange({ ...value, from: optional(e.target.value) })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${fieldId}-to`}>To</Label>
              <Input
                id={`${fieldId}-to`}
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

      <DropdownMenu.Root>
        <DropdownMenu.Trigger className={menuTrigger(value.outcome !== undefined)}>
          <TriggerLabel>{value.outcome === undefined ? "Any outcome" : OUTCOME_FILTER_NAMES[value.outcome]}</TriggerLabel>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} className={menuSurface}>
            <DropdownMenu.RadioGroup
              value={value.outcome ?? ""}
              onValueChange={(next) => {
                const outcome = LabelOutcome.safeParse(next);
                onChange({ ...value, outcome: outcome.success ? outcome.data : undefined });
              }}
            >
              {(["", ...LabelOutcome.options] as const).map((outcome) => (
                <DropdownMenu.RadioItem key={outcome} value={outcome} className={menuItem}>
                  <span className="flex-1">{outcome === "" ? "Any outcome" : OUTCOME_FILTER_NAMES[outcome]}</span>
                  <DropdownMenu.ItemIndicator>
                    <CheckIcon />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Files whose labels Binary guessed and wants someone to look over. */}
      <button
        type="button"
        aria-pressed={value.check === true}
        onClick={() => onChange({ ...value, check: value.check === true ? undefined : true })}
        className={cn(menuTrigger(value.check === true), "px-2.5")}
      >
        {value.check === true ? <CheckIcon className="size-5 shrink-0" /> : null}
        Check this only
      </button>

      {hasFilters(value) ? (
        <button type="button" onClick={() => onChange({})} className={cn(menuTrigger(false), "px-2.5 text-content-tertiary")}>
          Clear
        </button>
      ) : null}
    </div>
  );
}
