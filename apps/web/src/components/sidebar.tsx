"use client";

import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { useId, useMemo, useState } from "react";
import { signOut } from "@/app/actions";
import { cn } from "@/lib/cn";
import { buildFolderTree, folderAncestors, folderHref, type FolderNode, type FolderPath } from "@/lib/folders";
import { folderIconClass, folderTint } from "@/lib/tints";
import type { ShellData } from "@/lib/shell-data";
import { PaletteTrigger } from "./command-palette";
import { CheckIcon } from "./icons/base-web";
import { ChevronSmallIcon, ChevronUpDownIcon, FolderFilledIcon, SearchOutlineIcon, SettingsIcon, SignOutIcon } from "./icons/drawn";
import { NeedsLookCountText } from "./labels/needs-look-count";
import { NAV, type Section } from "./nav";
import { menuItem, menuSurface } from "./ui/menu";
import { SidebarCount, SidebarGroupLabel, sidebarItemClass } from "./ui/sidebar-item";

export type ShellLocation = { section: Section; folder?: FolderPath };

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? (words[0]?.charAt(0) ?? "") + (words[1]?.charAt(0) ?? "") : name.trim().slice(0, 2);
  return letters.toUpperCase() || "?";
}

export function SidebarContent({ shell, location }: { shell: ShellData; location: ShellLocation }) {
  const groupId = useId();
  const tree = useMemo(() => buildFolderTree(shell.folders), [shell.folders]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-4 pb-6">
      <LabSwitcher shell={shell} />
      <PaletteTrigger
        data-closes-sheet
        className="mt-4 flex min-h-11 w-full items-center gap-2.5 rounded-control border border-border-opaque bg-background-secondary px-3 text-paragraph-medium text-content-tertiary transition-colors duration-150 ease-out hover:bg-button-secondary-hover md:min-h-10"
      >
        <SearchOutlineIcon className="size-5" />
        <span>Search</span>
        <kbd className="ml-auto rounded-md border border-border-raised px-1.5 font-sans text-label-xsmall text-content-tertiary">⌘K</kbd>
      </PaletteTrigger>

      <nav aria-label="Main" className="mt-4">
        <ul className="grid gap-0.5">
          {NAV.map(({ section, href, label, Icon }) => {
            const active = location.section === section && (location.folder === undefined || location.folder === "");
            return (
              <li key={section}>
                <Link href={href} aria-current={active ? "page" : undefined} className={sidebarItemClass(active)}>
                  <Icon className="size-5 text-content-secondary group-hover:text-content-primary" />
                  {label}
                  {section === "needs-look" ? (
                    <NeedsLookCountText className="ml-auto pl-2 text-label-small text-content-tertiary tabular-nums" />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {tree.root.children.length > 0 ? (
        <section aria-labelledby={groupId}>
          <SidebarGroupLabel id={groupId}>Folders</SidebarGroupLabel>
          <FolderTreeList nodes={tree.root.children} current={location.folder} />
        </section>
      ) : null}
    </div>
  );
}

function LabSwitcher({ shell }: { shell: ShellData }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex min-h-12 w-full items-center gap-3 rounded-control px-1.5 py-1 text-left transition-colors duration-150 ease-out hover:bg-background-secondary">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-control border border-border-raised bg-background-secondary text-label-small font-semibold text-content-primary"
        >
          {initials(shell.labName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label-medium text-content-primary">{shell.labName}</span>
          <span className="block text-paragraph-xsmall text-content-tertiary">
            {shell.memberCount === 1 ? "1 member" : `${shell.memberCount} members`}
          </span>
        </span>
        <ChevronUpDownIcon className="size-5 text-content-tertiary" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={cn(menuSurface, "w-[var(--radix-dropdown-menu-trigger-width)] min-w-64")}>
          <DropdownMenu.Label className="px-3 pt-2 pb-1 text-paragraph-xsmall text-content-tertiary">Labs</DropdownMenu.Label>
          <DropdownMenu.Item className={menuItem}>
            <span className="min-w-0 flex-1 truncate">{shell.labName}</span>
            <CheckIcon className="size-5" />
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border-opaque" />
          <p className="truncate px-3 py-2 text-paragraph-small text-content-tertiary">{shell.email}</p>
          <DropdownMenu.Item asChild className={menuItem}>
            <Link href="/lab">
              <SettingsIcon className="size-5 text-content-secondary" />
              Settings
            </Link>
          </DropdownMenu.Item>
          <form action={signOut}>
            <DropdownMenu.Item asChild className={menuItem}>
              <button type="submit">
                <SignOutIcon className="size-5 text-content-secondary" />
                Sign out
              </button>
            </DropdownMenu.Item>
          </form>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function FolderTreeList({ nodes, current }: { nodes: FolderNode[]; current: FolderPath | undefined }) {
  // Ancestors of the open folder start expanded and re-open when it changes.
  const [expanded, setExpanded] = useState<ReadonlySet<FolderPath>>(() => new Set(current === undefined ? [] : folderAncestors(current)));
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    if (current !== undefined) setExpanded((prev) => new Set([...prev, ...folderAncestors(current)]));
  }
  const toggle = (path: FolderPath) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return <TreeLevel nodes={nodes} current={current} expanded={expanded} onToggle={toggle} />;
}

function TreeLevel({
  nodes,
  current,
  expanded,
  onToggle,
}: {
  nodes: FolderNode[];
  current: FolderPath | undefined;
  expanded: ReadonlySet<FolderPath>;
  onToggle: (path: FolderPath) => void;
}) {
  return (
    <ul className="grid gap-0.5">
      {nodes.map((node) => {
        const open = expanded.has(node.path);
        const active = node.path === current;
        const hasChildren = node.children.length > 0;
        return (
          <li key={node.path}>
            <div className={cn(sidebarItemClass(active), "gap-1 pl-0.5")}>
              {hasChildren ? (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => onToggle(node.path)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-content-tertiary hover:text-content-primary md:size-6"
                >
                  <ChevronSmallIcon className={cn("size-4 transition-transform duration-150 ease-out", open && "rotate-90")} />
                  <span className="sr-only">
                    {open ? "Collapse" : "Expand"} {node.name}
                  </span>
                </button>
              ) : (
                <span className="size-8 shrink-0 md:size-6" />
              )}
              <Link
                href={folderHref(node.path)}
                aria-current={active ? "page" : undefined}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md md:min-h-9"
              >
                <FolderFilledIcon className={cn("size-5", folderIconClass(folderTint(node.path)))} />
                <span className="truncate">{node.name}</span>
                <SidebarCount value={node.totalFiles} />
              </Link>
            </div>
            {hasChildren && open ? (
              <div className="ml-[15px] border-l border-border-opaque pl-1.5 md:ml-3">
                <TreeLevel nodes={node.children} current={current} expanded={expanded} onToggle={onToggle} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
