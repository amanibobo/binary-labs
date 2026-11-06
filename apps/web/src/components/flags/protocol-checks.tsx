"use client";

import Link from "next/link";
import { useId } from "react";
import { measureText, rangeText, usefulText, type CheckSpec } from "@/lib/checks";
import { usefulnessKey, type Flag, type UsefulnessByCheck } from "@/lib/flags";
import type { ProtocolId } from "@/lib/ids";
import { protocolHref } from "@/lib/protocols";
import { buttonVariants } from "../ui/button";
import { dataRow, dataSurface } from "../ui/data-table";
import { FlagLine } from "./file-flags";

// What a protocol page shows of its checks: the rules of the version on screen, the open flags
// raised against it, and for admins how people answered each check's flags.
export type ProtocolChecksData = { checks: CheckSpec[]; flags: Flag[]; usefulness: UsefulnessByCheck | null };

export const NO_CHECKS: ProtocolChecksData = { checks: [], flags: [], usefulness: null };

export function checksHref(id: ProtocolId, focus?: { checkId: string }): string {
  return focus === undefined ? `${protocolHref(id)}/checks` : `${protocolHref(id)}/checks?check=${focus.checkId}`;
}

export function ProtocolChecks({ protocolId, data, editable }: { protocolId: ProtocolId; data: ProtocolChecksData; editable: boolean }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-14">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id={headingId} className="text-heading-xsmall">
          Checks
        </h2>
        {editable ? (
          <Link href={checksHref(protocolId)} className={buttonVariants({ variant: "secondary", size: "compact" })}>
            {data.checks.length === 0 ? "Add a check" : "Edit checks"}
          </Link>
        ) : null}
      </div>
      {data.checks.length === 0 ? (
        <p className="text-paragraph-medium text-content-tertiary">
          {editable ? "No checks yet. Add one and this protocol's data files are checked as they arrive." : "No checks."}
        </p>
      ) : (
        <ul className={dataSurface}>
          {data.checks.map((check) => {
            const open = data.flags.filter((f) => f.checkId === check.id);
            const usefulness = data.usefulness?.[usefulnessKey(protocolId, check.id)];
            return (
              <li key={check.id} className={dataRow}>
                <div className="px-4 py-4 sm:px-5">
                  <p className="text-label-medium text-content-primary">{check.name}</p>
                  <p className="mt-0.5 text-paragraph-small text-content-secondary">
                    {measureText(check)}: <span className="font-mono">{rangeText(check.range, check.unit)}</span>
                  </p>
                  {data.usefulness === null ? null : (
                    <p className="mt-1 text-paragraph-xsmall text-content-tertiary">
                      {usefulText(usefulness ?? { flags: 0, useful: 0, wrong: 0, knownIssue: 0 })}
                    </p>
                  )}
                  {open.length === 0 ? null : (
                    <ul className="mt-3 grid gap-2">
                      {open.slice(0, 3).map((flag) => (
                        <li key={flag.id}>
                          <FlagLine flag={flag} on="protocol" />
                        </li>
                      ))}
                      {open.length > 3 ? (
                        <li>
                          <Link href="/flags" className="text-paragraph-small text-content-accent underline-offset-2 hover:underline">
                            {open.length - 3} more in Flags
                          </Link>
                        </li>
                      ) : null}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
