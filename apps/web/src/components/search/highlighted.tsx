import { highlight } from "@/lib/highlight";

// Renders matches as text nodes inside <mark>; the snippet is never parsed as HTML.
// Colors are Base Web's blue secondary tag pair, the one pairing of its blues that passes 4.5:1 on a tint.
export function Highlighted({ text, query }: { text: string; query: string }) {
  return highlight(text, query).map((segment, i) =>
    segment.match ? (
      <mark key={i} className="rounded-sm bg-tag-blue-background-secondary px-0.5 font-medium text-tag-blue-content-secondary">
        {segment.text}
      </mark>
    ) : (
      <span key={i}>{segment.text}</span>
    ),
  );
}
