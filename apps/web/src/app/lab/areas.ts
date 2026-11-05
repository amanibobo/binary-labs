import { z } from "zod";

// Settings opens on an overview; each area is its own view at /lab?area=<area>.
export const SettingsArea = z.enum(["dropbox", "experiments", "people", "members", "account", "delete"]);
export type SettingsArea = z.infer<typeof SettingsArea>;

export const AREA_COPY = {
  dropbox: { title: "Dropbox", helper: "Binary Labs reads one Dropbox folder and never changes a file in it." },
  experiments: {
    title: "Experiments",
    helper: "Labels link files to these. Other names are how an experiment shows up in folders and file names.",
  },
  people: {
    title: "People",
    helper: "Labels link files to these. Initials and other names are how a person shows up in folders and file names.",
  },
  members: { title: "Members", helper: "Everyone who can sign in to this lab." },
  account: { title: "Your account", helper: "The email you sign in with." },
  delete: { title: "Delete this lab", helper: "Removes everything Binary Labs holds for this lab. Files in Dropbox stay as they are." },
} as const satisfies Record<SettingsArea, { title: string; helper: string }>;

export function areaHref(area: SettingsArea): string {
  return `/lab?area=${area}`;
}
