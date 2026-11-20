import { dataRow, dataSurface } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";
import { formatInstant } from "@/lib/format";
import { FAILURE_PARTS, termsOf, type FailureList } from "@/lib/run-failure";

// Settings, Failure types: the fixed list a failed run is sorted by, read-only, and plainly a
// draft until a working scientist signs it off.
export function FailureTypesSection({ list }: { list: FailureList }) {
  return (
    <>
      <p className="max-w-prose rounded-card border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-primary">
        {list.signedOffAt === null
          ? `This is version ${list.version}, a draft. A working scientist still needs to sign it off before labs rely on it, so it may change. A run keeps the version it was sorted with.`
          : `Version ${list.version}, signed off${list.signedOffBy === null ? "" : ` by ${list.signedOffBy}`} on ${formatInstant(list.signedOffAt, "UTC")}. A run keeps the version it was sorted with.`}
      </p>
      {FAILURE_PARTS.map(({ prefix, question }) => (
        <section key={prefix} aria-label={question}>
          <h2 className="mb-3 text-label-large text-content-primary">{question}</h2>
          <ul className={dataSurface}>
            {termsOf(list, prefix).map((t) => (
              <li key={t.code} className={cn(dataRow, "px-5 py-2.5 sm:px-6")}>
                <span className="block text-label-medium text-content-primary">{t.label}</span>
                {t.hint === null ? null : <span className="block text-paragraph-small text-content-tertiary">{t.hint}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
