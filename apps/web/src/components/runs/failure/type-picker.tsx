"use client";

import Link from "next/link";
import { useId } from "react";
import { Caption } from "@/components/ui/field";
import { FAILURE_PARTS, termsOf, type FailureList, type FailurePart, type FailureType } from "@/lib/run-failure";
import type { RunRecord } from "@/lib/run-record";
import { useRunsApi } from "../runs-api";
import type { Write } from "./cause";

const select =
  "h-8 w-full rounded-md border border-border-opaque bg-background-primary px-1.5 text-paragraph-small text-content-primary max-sm:h-11 max-sm:text-paragraph-medium";

// The failure type from the fixed list, so runs from different labs line up: three plain
// questions, each saved as it's picked. A run coded in an older version keeps its codes.
export function TypePicker({ run, list, disabled, write }: { run: RunRecord; list: FailureList | undefined; disabled: boolean; write: Write }) {
  const api = useRunsApi();
  const id = useId();
  const f = run.failure;
  const current: Record<FailurePart, string | null> = { technique: f.technique, failedStep: f.failedStep, causeCategory: f.causeCategory };

  const pick = (part: FailurePart, code: string | null) => {
    if (list === undefined) return;
    const next = { ...current, [part]: code };
    const type: FailureType | null = Object.values(next).every((c) => c === null) ? null : { version: f.taxonomyVersion ?? list.version, ...next };
    void write(() => api.setFailureType(run.id, type));
  };

  return (
    <div className="grid gap-1.5">
      <h3 className="text-label-medium text-content-primary">Sort it</h3>
      <Caption className="max-w-prose">
        Three questions from a fixed list, so runs like this one can be found later, here and in other labs. The list is a{" "}
        <Link href="/settings/failure-types" className="underline underline-offset-4">
          draft
        </Link>{" "}
        until a working scientist signs it off.
      </Caption>
      <div className="mt-1 grid max-w-2xl gap-3 sm:grid-cols-3">
        {FAILURE_PARTS.map(({ part, prefix, question }) => {
          const terms = list === undefined ? [] : termsOf(list, prefix);
          const chosen = terms.find((t) => t.code === current[part]);
          return (
            <div key={part} className="grid content-start gap-1">
              <label htmlFor={`${id}-${part}`} className="text-paragraph-small text-content-secondary">
                {question}
              </label>
              <select
                id={`${id}-${part}`}
                value={current[part] ?? ""}
                disabled={disabled || list === undefined}
                onChange={(e) => pick(part, e.target.value === "" ? null : e.target.value)}
                className={select}
              >
                <option value="">Not picked</option>
                {current[part] !== null && chosen === undefined ? <option value={current[part]}>{current[part]}</option> : null}
                {terms.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
              </select>
              {chosen?.hint == null ? null : <Caption>{chosen.hint}</Caption>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
