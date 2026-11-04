import { highlight } from "@/lib/highlight";

// Renders matches as text nodes inside <mark>; the snippet is never parsed as HTML.
export function Highlighted({ text, query }: { text: string; query: string }) {
  return highlight(text, query).map((segment, i) =>
    segment.match ? (
      <mark key={i} className="rounded-[3px] bg-mark px-px font-medium text-blue">
        {segment.text}
      </mark>
    ) : (
      <span key={i}>{segment.text}</span>
    ),
  );
}
