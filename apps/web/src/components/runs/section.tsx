import type { ReactNode } from "react";
import type { RunRecord } from "@/lib/run-record";

// What the run page hands each of its sections: the run as it stands, and the way to hand
// back the run a write returned so the whole page shows it.
export type RunSectionProps = { run: RunRecord; onChange: (run: RunRecord) => void };

// A section of the run page: a heading, an optional line under it, then its content.
export function RunSection({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-10 min-w-0">
      <h2 className="text-label-large text-content-primary">{title}</h2>
      {note === undefined ? null : <p className="mt-1 max-w-prose text-paragraph-small text-content-tertiary">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
