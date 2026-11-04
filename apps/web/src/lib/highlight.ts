export type Segment = { text: string; match: boolean };

// Same tokenizing as prefix_tsquery in 0002_search.sql: alphanumeric runs of
// two or more characters, matched as word prefixes.
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  return [...new Set(words)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

function termPattern(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  // The database stems ("gels" matches "gel"), so drop a plural "s" before prefix matching.
  const stems = terms.map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
  const alternatives = [...new Set(stems)].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})[\\p{L}\\p{N}]*`, "giu");
}

export function highlight(text: string, query: string): Segment[] {
  const pattern = termPattern(queryTerms(query));
  if (pattern === null || text === "") return text === "" ? [] : [{ text, match: false }];
  const segments: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index;
    if (start > last) segments.push({ text: text.slice(last, start), match: false });
    segments.push({ text: m[0], match: true });
    last = start + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: false });
  return segments;
}

// A window of `text` around the first match, cut on word boundaries.
export function excerpt(text: string, query: string, maxChars = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  const pattern = termPattern(queryTerms(query));
  const first = pattern === null ? null : pattern.exec(flat);
  const anchor = first === null ? 0 : first.index;
  let start = Math.max(0, anchor - Math.floor(maxChars / 3));
  let end = Math.min(flat.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  if (start > 0) start = flat.indexOf(" ", start) + 1 || start;
  if (end < flat.length) end = flat.lastIndexOf(" ", end) > start ? flat.lastIndexOf(" ", end) : end;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
