"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useId } from "react";
import { FAILURE_PARTS, termsOf } from "@/lib/run-failure";
import { STATUS_CHOICES, type RunListFilter } from "@/lib/run-record";
import { useRunsApi } from "./runs-api";

const select =
  "h-8 w-full rounded-md border border-border-opaque bg-background-primary px-1.5 text-paragraph-small text-content-primary max-sm:h-11 max-sm:text-paragraph-medium";

// Each failure question filters one key of the list's address.
const KEYS = { technique: "technique", failedStep: "step", causeCategory: "cause" } as const satisfies Record<(typeof FAILURE_PARTS)[number]["part"], keyof RunListFilter>;

// Slice A's place above the runs list: how it went, and the failure type. The list reads its
// filter from the address (?status=, ?technique=, ?step=, ?cause=), so a pick only changes it.
export function RunFilters({ filter }: { filter: RunListFilter }) {
  const api = useRunsApi();
  const router = useRouter();
  const path = usePathname();
  const id = useId();
  const list = useQuery({ queryKey: ["failure-list"], queryFn: ({ signal }) => api.failureList(signal), staleTime: Infinity });

  const go = (key: keyof RunListFilter, value: string) => {
    const next = new URLSearchParams(Object.entries(filter).flatMap(([k, v]) => (typeof v === "string" && k !== key ? [[k, v]] : [])));
    if (value !== "") next.set(key, value);
    const query = next.toString();
    router.push(query === "" ? path : `${path}?${query}`);
  };
  const filtered = Object.keys(filter).length > 0;

  return (
    <div role="search" aria-label="Filter runs" className="mt-8 grid gap-3 sm:grid-cols-4">
      <div className="grid content-start gap-1">
        <label htmlFor={`${id}-status`} className="text-paragraph-small text-content-secondary">
          How it went
        </label>
        <select id={`${id}-status`} value={filter.status ?? ""} onChange={(e) => go("status", e.target.value)} className={select}>
          <option value="">Any</option>
          {STATUS_CHOICES.map((c) => (
            <option key={c.status} value={c.status}>
              {c.label}
            </option>
          ))}
          <option value="none">Not marked yet</option>
        </select>
      </div>
      {FAILURE_PARTS.map(({ part, prefix, question, any }) => {
        const key = KEYS[part];
        const terms = list.data === undefined ? [] : termsOf(list.data, prefix);
        const value = filter[key] ?? "";
        return (
          <div key={part} className="grid content-start gap-1">
            <label htmlFor={`${id}-${key}`} className="text-paragraph-small text-content-secondary">
              {question}
            </label>
            <select id={`${id}-${key}`} value={value} disabled={list.data === undefined && value === ""} onChange={(e) => go(key, e.target.value)} className={select}>
              <option value="">{any}</option>
              {value !== "" && !terms.some((t) => t.code === value) ? <option value={value}>{value}</option> : null}
              {terms.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {filtered ? (
        <button
          type="button"
          onClick={() => router.push(path)}
          className="-mx-1.5 justify-self-start rounded-md px-1.5 text-label-small text-content-tertiary hover:text-content-primary max-sm:min-h-11 sm:col-span-4"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
