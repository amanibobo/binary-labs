import Link from "next/link";
import { useId } from "react";
import { excerpt } from "@/lib/highlight";
import { KIND_NAMES, protocolHref, type ProtocolHit } from "@/lib/protocols";
import { ProtocolIcon } from "../icons/drawn";
import { Highlighted } from "../search/highlighted";

// The small group of matching protocols above the file results. Rows keep the file rows'
// left column, so both lists' text starts at the same edge.
export function ProtocolResults({ hits, query }: { hits: ProtocolHit[]; query: string }) {
  const headingId = useId();
  if (hits.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="mb-8">
      <h2 id={headingId} className="mb-1 px-3 text-label-small text-content-tertiary">
        Protocols
      </h2>
      <ul>
        {hits.map((hit) => (
          <li key={hit.id}>
            <Link
              href={protocolHref(hit.id)}
              className="flex items-start gap-4 rounded-xl px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-background-secondary focus-visible:outline-offset-[-2px]"
            >
              <span className="flex w-14 shrink-0 justify-center pt-0.5 sm:w-16">
                <ProtocolIcon className="text-content-secondary" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label-medium text-content-primary">
                  <Highlighted text={hit.title} query={query} />
                </span>
                {hit.snippet === "" ? null : (
                  <span className="mt-0.5 line-clamp-1 text-paragraph-small text-content-secondary">
                    <Highlighted text={excerpt(hit.snippet, query, 140)} query={query} />
                  </span>
                )}
                <span className="mt-0.5 block text-paragraph-xsmall text-content-tertiary">
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
