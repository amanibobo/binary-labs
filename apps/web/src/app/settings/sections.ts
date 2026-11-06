import { z } from "zod";

// Each section is its own page at /settings/<section>; /settings is the section list on a phone
// and General on a desktop.
export const SettingsSection = z.enum(["general", "members", "dropbox", "instruments", "experiments", "people", "account", "appearance"]);
export type SettingsSection = z.infer<typeof SettingsSection>;

export const SETTINGS_GROUPS = [
  { label: "Lab", sections: ["general", "members", "dropbox", "instruments", "experiments", "people"] },
  { label: "You", sections: ["account", "appearance"] },
] as const satisfies readonly { label: string; sections: readonly SettingsSection[] }[];

export const SECTION_COPY = {
  general: { title: "General", helper: "The lab's name, a copy of its protocols, and deleting it." },
  members: { title: "Members", helper: "Everyone who can sign in to this lab." },
  dropbox: { title: "Dropbox", helper: "Binary reads one Dropbox folder and never changes a file in it." },
  instruments: { title: "Instruments", helper: "Instrument PCs that send their new files here by themselves." },
  experiments: { title: "Experiments", helper: "Files are labeled with these. Add the short names people use in file names." },
  people: { title: "People", helper: "Files are labeled with these. Add the initials people use in file names." },
  account: { title: "Account", helper: "The email you sign in with." },
  appearance: { title: "Appearance", helper: "Light, dark, or the same as this device. Saved on this browser." },
} as const satisfies Record<SettingsSection, { title: string; helper: string }>;

export const SETTINGS_HOME = "/settings";

export function settingsHref(section: SettingsSection): string {
  return `${SETTINGS_HOME}/${section}`;
}

export const DROPBOX_FOLDER_HREF = "/settings/dropbox/folder";

// Settings used to live at /lab?area=<area>, with "delete" as its own area; old links,
// bookmarks and the Dropbox notices still arrive there.
const LegacyArea = z.enum(["dropbox", "instruments", "experiments", "people", "members", "account", "appearance", "delete"]);
// The OAuth callback's notices; an unknown one reads as a failure, as it always did.
export const DropboxNotice = z.enum(["denied", "expired", "failed"]).catch("failed");
export type DropboxNotice = z.infer<typeof DropboxNotice>;

export function legacySettingsHref(params: { area?: string | string[]; dropbox?: string | string[] }): string {
  if (params.dropbox !== undefined) return `${settingsHref("dropbox")}?dropbox=${DropboxNotice.parse(params.dropbox)}`;
  const area = LegacyArea.safeParse(params.area);
  if (!area.success) return SETTINGS_HOME;
  return settingsHref(area.data === "delete" ? "general" : area.data);
}
