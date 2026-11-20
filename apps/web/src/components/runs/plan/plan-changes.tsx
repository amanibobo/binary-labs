import { changesLine, changeTitle, type PlanChange } from "@/lib/as-run";
import { cn } from "@/lib/cn";
import { dataRow, dataSurface } from "../../ui/data-table";

// What changed from the protocol, one plain entry per change, in the protocol's order.
export function PlanChanges({ changes }: { changes: readonly PlanChange[] }) {
  return (
    <div className="grid gap-2">
      <p className="text-label-medium text-content-primary">{changesLine(changes.length)}</p>
      <ul aria-label="Changes from the protocol" className={dataSurface}>
        {changes.map((change, i) => (
          <li key={i} className={cn(dataRow, "grid gap-0.5 px-4 py-3 text-paragraph-small")}>
            <p className="text-label-small text-content-primary">{changeTitle(change)}</p>
            {change.kind === "changed" ? (
              <>
                <p className="text-content-tertiary">
                  Written: <span className="text-content-secondary">{change.was}</span>
                </p>
                <p className="text-content-tertiary">
                  Done: <span className="text-content-primary">{change.now}</span>
                </p>
              </>
            ) : change.kind === "left_out" ? (
              <p className="text-content-secondary line-through decoration-content-tertiary">{change.text}</p>
            ) : (
              change.lines.map((line, k) => (
                <p key={k} className="text-content-primary">
                  {line}
                </p>
              ))
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
