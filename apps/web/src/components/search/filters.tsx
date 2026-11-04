"use client";

import { useId } from "react";
import { FILE_KINDS, FileKind, type SearchFilters } from "@/lib/domain";
import { hasFilters } from "@/lib/filters";
import { cn } from "@/lib/cn";
import { controlClass } from "../ui/field";

const KIND_LABELS = {
  pdf: "PDF",
  spreadsheet: "Spreadsheet",
  document: "Document",
  text: "Text",
  image: "Image",
  other: "Other",
} satisfies Record<FileKind, string>;

const optional = (value: string) => (value === "" ? undefined : value);

export function Filters({ value, onChange }: { value: SearchFilters; onChange: (next: SearchFilters) => void }) {
  const id = useId();
  const labelClass = "mb-1 block text-[13px] text-muted";
  const compact = cn(controlClass, "min-h-11 px-2.5 text-sm");
  return (
    <fieldset className="mt-3">
      <legend className="sr-only">Filters</legend>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-[1fr_1.6fr_1fr_1fr]">
        <div>
          <label htmlFor={`${id}-kind`} className={labelClass}>
            Kind
          </label>
          <select
            id={`${id}-kind`}
            className={compact}
            value={value.kind ?? ""}
            onChange={(e) => {
              const kind = FileKind.safeParse(e.target.value);
              onChange({ ...value, kind: kind.success ? kind.data : undefined });
            }}
          >
            <option value="">Any kind</option>
            {FILE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-prefix`} className={labelClass}>
            Folder
          </label>
          <input
            id={`${id}-prefix`}
            className={cn(compact, "font-mono text-[13px]")}
            placeholder="/Lab/Gels"
            spellCheck={false}
            autoCapitalize="off"
            value={value.prefix ?? ""}
            onChange={(e) => onChange({ ...value, prefix: optional(e.target.value.trim()) })}
          />
        </div>
        <div>
          <label htmlFor={`${id}-from`} className={labelClass}>
            Modified from
          </label>
          <input
            id={`${id}-from`}
            type="date"
            className={compact}
            value={value.from ?? ""}
            max={value.to}
            onChange={(e) => onChange({ ...value, from: optional(e.target.value) })}
          />
        </div>
        <div>
          <label htmlFor={`${id}-to`} className={labelClass}>
            To
          </label>
          <input
            id={`${id}-to`}
            type="date"
            className={compact}
            value={value.to ?? ""}
            min={value.from}
            onChange={(e) => onChange({ ...value, to: optional(e.target.value) })}
          />
        </div>
      </div>
      {hasFilters(value) ? (
        <button
          type="button"
          onClick={() => onChange({})}
          className="mt-1 min-h-11 rounded-control px-1 text-sm font-medium text-green hover:underline"
        >
          Clear filters
        </button>
      ) : null}
    </fieldset>
  );
}
