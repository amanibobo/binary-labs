// Moving between file rows with the keyboard. Arrow keys step one row and stop at the ends
// (no wrap, so holding a key never jumps back to the top); Home and End go to the first and
// last row. Any other key is left to the browser.
export type RowKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function isRowKey(key: string): key is RowKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
}

export function rowStep({ key, index, count }: { key: RowKey; index: number; count: number }): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return index + 1 < count ? index + 1 : null;
    case "ArrowUp":
      return index > 0 ? index - 1 : null;
    case "Home":
      return index === 0 ? null : 0;
    case "End":
      return index === count - 1 ? null : count - 1;
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

// Letters on a file row: E edits its labels, C makes a chart from a data sheet and X picks the
// row to change with others (where rows can be picked). They never fire while someone types in
// a field, with Ctrl, Alt or Cmd held (the browser's shortcuts stay its own), or while a key
// repeats.
export type RowShortcut = "edit" | "chart" | "select";

export function rowShortcut({
  key,
  modified,
  repeat,
  typing,
  sheet,
  selectable = false,
}: {
  key: string;
  modified: boolean;
  repeat: boolean;
  typing: boolean;
  sheet: boolean;
  selectable?: boolean;
}): RowShortcut | null {
  if (modified || repeat || typing) return null;
  switch (key.toLowerCase()) {
    case "e":
      return "edit";
    case "c":
      return sheet ? "chart" : null;
    case "x":
      return selectable ? "select" : null;
    default:
      return null;
  }
}

// Where a key press counts as typing: a text field, a list box or anything editable.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null;
}
