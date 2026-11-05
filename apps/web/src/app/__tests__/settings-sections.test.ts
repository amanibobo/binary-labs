import { describe, expect, it } from "vitest";
import { checklist, NO_PROGRESS, QUIET_STATE } from "@/lib/onboarding";
import { NAV, SETTINGS_NAV } from "@/components/nav";
import { DROPBOX_FOLDER_HREF, legacySettingsHref, SETTINGS_GROUPS, SettingsSection, settingsHref } from "../settings/sections";

describe("settings sections", () => {
  it("lists every section once, lab sections before your own", () => {
    const listed = SETTINGS_GROUPS.flatMap((g) => g.sections);
    expect([...listed].sort()).toEqual([...SettingsSection.options].sort());
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(["Lab", "You"]);
  });

  it("opens each section at its own path", () => {
    expect(settingsHref("members")).toBe("/settings/members");
    expect(DROPBOX_FOLDER_HREF.startsWith(settingsHref("dropbox"))).toBe(true);
    expect(SETTINGS_NAV.href).toBe("/settings");
    expect(NAV.some((item) => item.href.startsWith("/lab"))).toBe(false);
  });
});

describe("old /lab links", () => {
  it.each([
    [{}, "/settings"],
    [{ area: "dropbox" }, "/settings/dropbox"],
    [{ area: "instruments" }, "/settings/instruments"],
    [{ area: "experiments" }, "/settings/experiments"],
    [{ area: "people" }, "/settings/people"],
    [{ area: "members" }, "/settings/members"],
    [{ area: "account" }, "/settings/account"],
    [{ area: "appearance" }, "/settings/appearance"],
    // Deleting the lab now sits at the foot of General.
    [{ area: "delete" }, "/settings/general"],
    [{ area: "nonsense" }, "/settings"],
    [{ area: ["members", "people"] }, "/settings"],
  ])("%o goes to %s", (params, href) => {
    expect(legacySettingsHref(params)).toBe(href);
  });

  it("keeps the Dropbox sign-in notice, reading an unknown one as a failure", () => {
    expect(legacySettingsHref({ dropbox: "denied" })).toBe("/settings/dropbox?dropbox=denied");
    expect(legacySettingsHref({ dropbox: "expired", area: "members" })).toBe("/settings/dropbox?dropbox=expired");
    expect(legacySettingsHref({ dropbox: "weird" })).toBe("/settings/dropbox?dropbox=failed");
  });
});

describe("getting started", () => {
  it("links the admin's setup items to their settings sections", () => {
    const items = checklist({ role: "admin", progress: NO_PROGRESS, state: QUIET_STATE });
    const href = (id: string) => {
      const action = items.find((i) => i.id === id)?.action;
      return action?.kind === "link" ? action.href : null;
    };
    expect(href("files")).toBe(settingsHref("dropbox"));
    expect(href("invite")).toBe(settingsHref("members"));
  });
});
