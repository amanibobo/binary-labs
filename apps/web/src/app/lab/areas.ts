import { z } from "zod";

// Settings opens on an overview; each area is its own view at /lab?area=<area>.
export const SettingsArea = z.enum(["dropbox", "instruments", "experiments", "people", "members", "account", "appearance", "delete"]);
export type SettingsArea = z.infer<typeof SettingsArea>;

export const AREA_COPY = {
  dropbox: { title: "Dropbox", helper: "Binary reads one Dropbox folder and never changes a file in it." },
  instruments: {
    title: "Instruments",
    helper: "Instrument PCs that send their new files here by themselves. Binary never changes a file on them.",
  },
  experiments: {
    title: "Experiments",
    helper: "Files are labeled with these. Add the short names people use in file names.",
  },
  people: {
    title: "People",
    helper: "Files are labeled with these. Add the initials people use in file names.",
  },
  members: { title: "Members", helper: "Everyone who can sign in to this lab." },
  account: { title: "Your account", helper: "The email you sign in with." },
  appearance: { title: "Appearance", helper: "Light, dark, or the same as this device. Saved on this browser." },
  delete: { title: "Delete this lab", helper: "Removes everything Binary holds for this lab. Files in Dropbox stay as they are." },
} as const satisfies Record<SettingsArea, { title: string; helper: string }>;

export function areaHref(area: SettingsArea): string {
  return `/lab?area=${area}`;
}
