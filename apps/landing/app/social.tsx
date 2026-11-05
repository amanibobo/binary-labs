import type { ReactNode } from "react";
import { SOCIAL } from "./links";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const ICONS = {
  linkedin: (
    <Icon>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M8 10.5v6M8 7.6v.01M12 16.5v-6M12 13.2c0-1.6 1-2.7 2.4-2.7s2.1 1 2.1 2.6v3.4" />
    </Icon>
  ),
  instagram: (
    <Icon>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.2 6.8v.01" />
    </Icon>
  ),
  email: (
    <Icon>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </Icon>
  ),
  youtube: (
    <Icon>
      <rect x="2.5" y="5" width="19" height="14" rx="4" />
      <path d="m10.2 9.2 4.8 2.8-4.8 2.8z" fill="currentColor" />
    </Icon>
  ),
} as const satisfies Record<keyof typeof SOCIAL, ReactNode>;

const LABELS: Record<keyof typeof SOCIAL, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  email: "Email",
  youtube: "YouTube",
};

export function SocialLinks() {
  return (
    <ul className="-mr-3 flex items-center">
      {(Object.keys(SOCIAL) as (keyof typeof SOCIAL)[]).map((key) => (
        <li key={key}>
          <a
            href={SOCIAL[key]}
            aria-label={LABELS[key]}
            title={LABELS[key]}
            className="flex size-11 items-center justify-center text-black/40 transition-colors hover:text-black/80"
          >
            {ICONS[key]}
          </a>
        </li>
      ))}
    </ul>
  );
}
