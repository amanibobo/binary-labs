// What changed between two versions of a file's text, line by line.

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

// A run of unchanged lines folded away between two changes.
export type DiffRow = DiffLine | { kind: "gap"; count: number };

// The table below holds (changed lines before + 1) x (changed lines after + 1) numbers; past
// this the two texts are compared by their counts alone.
const MAX_CELLS = 2_000_000;

function linesOf(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// Null when the changed part is too long to line up.
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const rows = midA.length + 1;
  const cols = midB.length + 1;
  if (rows * cols > MAX_CELLS) return null;

  // common[i * cols + j]: the longest run of lines midA from i and midB from j share, in order.
  const common = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      common[i * cols + j] =
        midA[i] === midB[j]
          ? (common[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * cols + j] ?? 0, common[i * cols + j + 1] ?? 0);
    }
  }
  const same = (text: string): DiffLine => ({ kind: "same", text });
  const out: DiffLine[] = a.slice(0, head).map(same);
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    const left = midA[i];
    const right = midB[j];
    if (left !== undefined && right !== undefined && left === right) {
      out.push(same(left));
      i += 1;
      j += 1;
    } else if (left !== undefined && (right === undefined || (common[(i + 1) * cols + j] ?? 0) >= (common[i * cols + j + 1] ?? 0))) {
      out.push({ kind: "removed", text: left });
      i += 1;
    } else if (right !== undefined) {
      out.push({ kind: "added", text: right });
      j += 1;
    }
  }
  return [...out, ...a.slice(a.length - tail).map(same)];
}

export type LineCounts = { added: number; removed: number };

export function diffCounts(lines: readonly DiffLine[]): LineCounts {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}

// The changed lines with a few unchanged ones around each, and the rest folded into gaps.
export function diffRows(lines: readonly DiffLine[], context = 2): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, at) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, at - context); k <= Math.min(lines.length - 1, at + context); k += 1) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let hidden = 0;
  lines.forEach((line, at) => {
    if (keep[at] === true) {
      if (hidden > 0) rows.push({ kind: "gap", count: hidden });
      hidden = 0;
      rows.push(line);
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) rows.push({ kind: "gap", count: hidden });
  return rows;
}
