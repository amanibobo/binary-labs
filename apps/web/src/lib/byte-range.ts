// One HTTP byte range (RFC 9110 §14), the kind a video element asks for while it plays and
// seeks. Several ranges in one request are answered with the whole file, which the spec allows.
export type ByteRange =
  | { kind: "whole" }
  // Inclusive at both ends, as Content-Range writes them.
  | { kind: "part"; start: number; end: number }
  | { kind: "unsatisfiable" };

const SINGLE = /^bytes=(\d*)-(\d*)$/;

export function parseRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: "whole" };
  const match = SINGLE.exec(header.trim());
  if (match === null) return { kind: "whole" };
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return { kind: "whole" };
  if (first === "") {
    // A suffix: the last N bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "part", start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return { kind: "whole" };
  return { kind: "part", start, end };
}

// Whether this request starts reading the file, as opposed to a seek or the next stretch of a
// video already playing; only that one counts as opening the file.
export function startsAtBeginning(header: string | null): boolean {
  if (header === null) return true;
  return /^bytes=0-/.test(header.trim());
}
