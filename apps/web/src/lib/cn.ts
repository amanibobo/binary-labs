import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge only knows Tailwind's own font sizes; without the Base Web type
// scale it reads `text-label-medium` as a color and drops `text-content-*`.
const BASE_TEXT_SIZES = ["paragraph", "label", "heading"].flatMap((role) =>
  ["xsmall", "small", "medium", "large", "xlarge"].map((size) => `${role}-${size}`),
);

const twMerge = extendTailwindMerge({ extend: { theme: { text: BASE_TEXT_SIZES } } });

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
