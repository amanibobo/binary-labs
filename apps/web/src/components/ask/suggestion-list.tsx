import Link from "next/link";
import { suggestionHref, type OpenSuggestion } from "@/lib/suggestions";
import { When } from "../ui/when";

// The suggestions waiting for someone, newest first.
export function SuggestionList({ items }: { items: readonly OpenSuggestion[] }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 sm:px-8 sm:pt-12">
      <h1 className="text-heading-medium sm:text-heading-large">Suggestions</h1>
      <p className="mt-2 max-w-prose text-paragraph-medium text-content-secondary">Changes the AI proposed. Nothing changes until someone approves it.</p>
      {items.length === 0 ? (
        <p className="mt-8 text-paragraph-medium text-content-tertiary">Nothing is waiting. Ask for one from an answer or a protocol.</p>
      ) : (
        <ul className="-mx-3 mt-6">
          {items.map((s) => (
            <li key={s.id}>
              <Link href={suggestionHref(s.id)} className="block rounded-xl px-3 py-3 transition-colors duration-150 ease-out hover:bg-background-secondary focus-visible:outline-offset-[-2px]">
                <span className="block text-paragraph-medium text-content-primary">{s.summary}</span>
                <span className="mt-0.5 block text-paragraph-xsmall text-content-tertiary">
                  {s.kind === "protocol_edit" ? "Protocol edit" : "Label fixes"} · <When iso={s.createdAt} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
