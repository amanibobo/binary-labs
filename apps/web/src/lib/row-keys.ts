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
