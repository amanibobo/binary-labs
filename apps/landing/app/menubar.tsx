"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { APP_URL, PILOT_MAILTO } from "./links";
import { Mark } from "./mark";

const NAV = [
  { label: "How it works", href: "#features" },
  { label: "Why", href: "#why" },
  { label: "Details", href: "#details" },
  { label: "Sign in", href: APP_URL },
] as const;

const STATUS: readonly { label: string; icon: ReactNode; pill: string; done: boolean }[] = [
  {
    label: "Dropbox connection",
    pill: "Lab Dropbox, read-only",
    done: true,
    icon: (
      <path d="M4.5 12.5h7.2a3 3 0 0 0 .4-6 4.2 4.2 0 0 0-8-.6A3.3 3.3 0 0 0 4.5 12.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    ),
  },
  {
    label: "Search index",
    pill: "Every file indexed",
    done: true,
    icon: (
      <>
        <circle cx="6.5" cy="6.5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M9.6 9.6l3.6 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  },
  {
    label: "Phone capture",
    pill: "Phone capture, coming next",
    done: false,
    icon: (
      <>
        <rect x="4" y="1.5" width="7" height="12" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6.5 11.3h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </>
    ),
  },
];

function subscribeMinute(onTick: () => void) {
  const timer = window.setInterval(onTick, 10_000);
  return () => window.clearInterval(timer);
}

function formatNow() {
  return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// The local time, like the clock in a menu bar. Empty on the server so hydration never disagrees.
function Clock() {
  const time = useSyncExternalStore(subscribeMinute, formatNow, () => "");
  return <span className="min-w-[56px] text-right text-[14px] tabular-nums tracking-[-0.42px] text-black/30">{time}</span>;
}

function StatusItem({ label, icon, pill, done }: (typeof STATUS)[number]) {
  return (
    <span className="status-item relative flex items-center">
      <button type="button" aria-label={`${label}: ${pill}`} className="grid size-[28px] place-items-center rounded-full text-black/70 outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#1d6ee5]">
        <svg viewBox="0 0 15 15" className="size-[15px]" aria-hidden>
          {icon}
        </svg>
      </button>
      <span className="status-pop" aria-hidden>
        <span className="status-pill">
          <span className="gloss" />
          <svg viewBox="0 0 15 15" className="relative z-[2] size-[16px]">
            {icon}
          </svg>
          <span className="relative z-[2]">{pill}</span>
          <svg viewBox="0 0 12 12" className={`relative z-[2] size-3 ${done ? "" : "opacity-0"}`}>
            <path d="M2 6.5l2.6 2.5L10 3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </span>
    </span>
  );
}

export function Menubar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-[200] border-b border-black/5 bg-[#f5f5f5] px-5 lg:px-6">
      <div className="flex h-[52px] items-center gap-3 lg:gap-5">
        <nav aria-label="Main" className="hidden flex-1 items-center gap-4 text-[14px] leading-none tracking-[-0.42px] text-black/55 lg:flex">
          <a href="#top" className="press font-medium text-black">
            Binary Labs
          </a>
          {NAV.map((item) => (
            <a key={item.label} href={item.href} className="press hover:text-black focus-visible:text-black">
              {item.label}
            </a>
          ))}
        </nav>

        <a href="#top" aria-label="Binary Labs, back to top" className="press flex h-[44px] w-[44px] shrink-0 items-center justify-center lg:w-[54px]">
          <Mark className="h-[26px] w-[26px] lg:h-[30px] lg:w-[30px]" />
        </a>

        <div className="flex flex-1 items-center justify-end gap-4">
          <div className="hidden items-center gap-3 lg:flex">
            {STATUS.map((s) => (
              <StatusItem key={s.label} {...s} />
            ))}
            <Clock />
          </div>
          <a href={PILOT_MAILTO} className="press flex h-[44px] items-center text-[14px] font-medium tracking-[-0.42px] text-[var(--link)] hover:opacity-80">
            Request a pilot
          </a>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((o) => !o)}
            className="-mr-2 grid size-[44px] place-items-center text-black/60 active:opacity-55 lg:hidden"
          >
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
              {open ? (
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              ) : (
                <>
                  <rect x="1.5" y="2.5" width="13" height="4.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <rect x="1.5" y="9" width="13" height="4.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <circle cx="11.5" cy="4.75" r="1.3" fill="currentColor" />
                  <circle cx="4.5" cy="11.25" r="1.3" fill="currentColor" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <nav id="mobile-nav" aria-label="Main" className="border-t border-black/5 pb-3 lg:hidden">
          {NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              onClick={() => setOpen(false)}
              className="flex h-[48px] items-center text-[18px] tracking-[-0.54px] text-black/70 active:text-black"
            >
              {item.label}
            </a>
          ))}
        </nav>
      )}
    </header>
  );
}
