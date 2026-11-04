import Link from "next/link";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { excerpt } from "@/lib/highlight";
import { KIND_NAMES, protocolHref, type ProtocolHit } from "@/lib/protocols";
import { ProtocolIcon } from "../icons/drawn";
import { Highlighted } from "../search/highlighted";
import { dataRow, dataSurface } from "../ui/data-table";

// The small group of matching pages that sits above the file results.
export function ProtocolResults({ hits, query }: { hits: ProtocolHit[]; query: string }) {
  const headingId = useId();
  if (hits.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="mb-10">
      <h2 id={headingId} className="mb-3 text-label-medium text-content-secondary">
        Protocols and tutorials
      </h2>
      <ul className={dataSurface}>
        {hits.map((hit) => (
          <li key={hit.id} className={cn(dataRow, "hover:bg-background-secondary")}>
            <Link href={protocolHref(hit.id)} className="flex items-start gap-4 py-3.5 pr-4 pl-4 sm:pr-5 sm:pl-5">
              <ProtocolIcon className="mt-0.5 text-content-secondary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label-medium text-content-primary">
                  <Highlighted text={hit.title} query={query} />
                </span>
                {hit.snippet === "" ? null : (
                  <span className="mt-1 line-clamp-2 text-paragraph-small text-content-secondary">
                    <Highlighted text={excerpt(hit.snippet, query, 180)} query={query} />
                  </span>
                )}
                <span className="mt-1.5 block text-paragraph-xsmall text-content-tertiary">
                  {KIND_NAMES[hit.kind]} · Version {hit.version}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
