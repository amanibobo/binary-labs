import Link from "next/link";
import { cn } from "@/lib/cn";
import { authorName, protocolHref, type AuthorNames, type HistoryEntry, type ProtocolVersion } from "@/lib/protocols";
import { dataRow, dataSurface } from "../ui/data-table";
import { CrumbBar } from "./crumb-bar";
import { When } from "@/components/ui/when";

// Every saved version, newest first; each opens as it was.
export function HistoryView({
  page,
  versions,
  authors,
}: {
  page: ProtocolVersion;
  versions: HistoryEntry[];
  authors: AuthorNames;
}) {
  const href = protocolHref(page.protocolId);
  return (
    <>
      <CrumbBar
        items={[
          { label: page.title, href },
          { label: "History", href: `${href}/history` },
        ]}
      />
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 sm:px-8 sm:pt-12">
        <h1 className="text-heading-medium">History</h1>
        <p className="mt-1 text-paragraph-small text-content-tertiary">
          {versions.length === 1 ? "1 version" : `${versions.length} versions`} of {page.title}. Saved versions never change.
        </p>
        <ol className={cn(dataSurface, "mt-8")}>
          {versions.map((v) => {
            const isCurrent = v.id === page.currentVersionId;
            return (
              <li key={v.id} className={cn(dataRow, "hover:bg-background-secondary")}>
                <Link
                  href={isCurrent ? href : protocolHref(page.protocolId, v.version)}
                  className="flex min-h-16 items-baseline gap-4 py-4 pr-4 pl-4 sm:pr-5 sm:pl-5"
                >
                  <span className="w-10 shrink-0 text-label-medium text-content-primary tabular-nums">v{v.version}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-label-medium text-content-primary">
                      {v.note ?? (v.version === 1 ? "First version" : "No note")}
                      {isCurrent ? <span className="text-content-tertiary"> · current</span> : null}
                    </span>
                    <span className="mt-1 block text-paragraph-small text-content-tertiary">
                      <When iso={v.createdAt} /> by {authorName(authors, v.author)}
                      {v.title === page.title ? null : <> · titled &ldquo;{v.title}&rdquo;</>}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}
