import { redirect } from "next/navigation";
import { legacySettingsHref } from "@/app/settings/sections";

// Settings moved to /settings/<section>; old links and bookmarks land on the same section.
export default async function LegacySettingsPage({ searchParams }: PageProps<"/lab">) {
  redirect(legacySettingsHref(await searchParams));
}
