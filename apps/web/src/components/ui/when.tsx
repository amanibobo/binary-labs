"use client";

import { useSyncExternalStore } from "react";
import { formatInstant } from "@/lib/format";

const noSubscribe = () => () => {};

// The server can't know the reader's time zone, so it renders the UTC day and the
// browser swaps in its own; an evening save in New York stays on the day it happened.
export function When({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    noSubscribe,
    () => formatInstant(iso),
    () => formatInstant(iso, "UTC"),
  );
  return <time dateTime={iso}>{text}</time>;
}
