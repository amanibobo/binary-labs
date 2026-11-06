import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronSmallIcon } from "@/components/icons/drawn";
import { dataRow, dataSurface } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";
import { SECTION_COPY, SETTINGS_GROUPS, SETTINGS_HOME, type SettingsSection } from "./sections";

type FrameProps = {
  // null is /settings itself: the section list on a phone, General beside it on a desktop.
  section: SettingsSection | null;
  labName: string;
  children: ReactNode;
  // The fixtures serve the same pages under /dev/fixtures/settings and keep their query.
  base?: string;
  query?: string;
};

// A section list on the left and the open section on the right; on a phone the list is its own
// screen and each section opens full width with a link back to it.
export function SettingsFrame({ section, labName, children, base = SETTINGS_HOME, query = "" }: FrameProps) {
  const shown = section ?? "general";
  const Heading = section === null ? "h2" : "h1";
  return (
    <div className="mx-auto flex w-full max-w-5xl gap-12 px-4 pt-6 pb-24 sm:px-8 md:pt-12">
      <nav aria-label="Settings" className={cn("w-full md:sticky md:top-12 md:w-48 md:shrink-0 md:self-start", section !== null && "hidden md:block")}>
        {section === null ? (
          <h1 className="text-heading-large md:text-heading-xsmall">Settings</h1>
        ) : (
          <p className="text-heading-xsmall">Settings</p>
        )}
        <p className="mt-1 truncate text-paragraph-medium text-content-tertiary md:text-paragraph-small">{labName}</p>
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.label} className="mt-6">
            <p className="px-4 pb-2 text-label-small text-content-tertiary md:px-3 md:pb-1">{group.label}</p>
            <ul className={cn(dataSurface, "md:overflow-visible md:rounded-none md:border-0 md:bg-transparent md:shadow-none")}>
              {group.sections.map((s) => {
                const active = s === shown;
                return (
                  <li key={s} className={cn(dataRow, "md:border-t-0")}>
                    <Link
                      href={`${base}/${s}${query}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-12 items-center gap-3 px-4 text-label-medium text-content-primary transition-colors duration-150 ease-out hover:bg-background-secondary",
                        "md:min-h-9 md:rounded-lg md:px-3",
                        active ? "md:bg-background-tertiary" : "md:text-content-secondary md:hover:text-content-primary",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{SECTION_COPY[s].title}</span>
                      <ChevronSmallIcon className="size-5 shrink-0 text-content-tertiary md:hidden" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className={cn("min-w-0 flex-1 md:max-w-2xl", section === null && "hidden md:block")}>
        {section === null ? null : (
          <Link
            href={`${base}${query}`}
            className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-control pr-2 text-label-medium text-content-tertiary transition-colors duration-150 ease-out hover:text-content-primary md:hidden"
          >
            <ChevronSmallIcon className="size-5 rotate-180" />
            Settings
          </Link>
        )}
        <header className="mt-2 md:mt-0">
          <Heading className="text-heading-small">{SECTION_COPY[shown].title}</Heading>
          <p className="mt-1 text-paragraph-medium text-content-tertiary">{SECTION_COPY[shown].helper}</p>
        </header>
        <div className="mt-8 grid gap-10">{children}</div>
      </div>
    </div>
  );
}

// A titled block of rows. Without a title it's one surface under the page's header.
export function SettingsGroup({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      {title === undefined ? null : (
        <div className="mb-3">
          <h2 className="text-label-large text-content-primary">{title}</h2>
          {description === undefined ? null : <p className="mt-0.5 text-paragraph-small text-content-tertiary">{description}</p>}
        </div>
      )}
      <div className={dataSurface}>{children}</div>
    </section>
  );
}

// A connected service or device: its icon, its name, one line of state and what you can do to it.
export function ConnectionRow({ icon, name, status, action, muted = false }: { icon: ReactNode; name: string; status: ReactNode; action?: ReactNode; muted?: boolean }) {
  return (
    <div className={cn(dataRow, "flex items-center gap-4 px-5 py-3 sm:min-h-16 sm:px-6")}>
      <span aria-hidden className="hidden size-10 shrink-0 items-center justify-center rounded-control border border-border-opaque bg-background-secondary text-content-secondary sm:flex">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-label-medium", muted ? "text-content-tertiary" : "text-content-primary")}>{name}</span>
        <span className="block text-paragraph-small text-content-tertiary [overflow-wrap:anywhere]">{status}</span>
      </span>
      {action === undefined || action === null ? null : <span className="flex shrink-0 items-center gap-2">{action}</span>}
    </div>
  );
}

// One setting: what it is and its value or help on the left, the control that changes it on the right.
export function SettingsRow({ label, children, action }: { label: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cn(dataRow, "flex flex-col gap-3 px-5 py-4 sm:min-h-16 sm:flex-row sm:items-center sm:gap-6 sm:px-6")}>
      <div className="min-w-0 flex-1">
        <div className="text-label-medium text-content-primary">{label}</div>
        {children === undefined ? null : <div className="mt-0.5 text-paragraph-small text-content-tertiary">{children}</div>}
      </div>
      {action === undefined || action === null ? null : <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}
