import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { loadShell } from "@/lib/shell-data";
import { requireMember, type Member } from "@/lib/viewer";
import { SECTION_COPY, type SettingsSection } from "./sections";
import { SettingsFrame } from "./settings-frame";

export function settingsMetadata(section: SettingsSection | null): Metadata {
  return { title: section === null ? "Settings" : `${SECTION_COPY[section].title} · Settings` };
}

// Every settings page: the signed-in member, the app shell, the section list, and the section's
// own body loaded beside the shell.
export async function renderSettings(section: SettingsSection | null, body: (member: Member) => Promise<ReactNode>): Promise<ReactNode> {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const [shell, content] = await Promise.all([loadShell(viewer), body(viewer)]);
  return (
    <AppShell shell={shell} location={{ section: "lab" }}>
      <SettingsFrame section={section} labName={viewer.lab.name}>
        {content}
      </SettingsFrame>
    </AppShell>
  );
}
