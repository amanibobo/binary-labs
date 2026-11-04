import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ConfigMissing } from "@/components/config-missing";
import { loadViewer } from "@/lib/viewer";
import { NewLabView } from "./new-lab-view";

export const metadata: Metadata = { title: "Create lab" };

export default async function NewLabPage() {
  const viewer = await loadViewer();
  switch (viewer.kind) {
    case "config_missing":
      return <ConfigMissing missing={viewer.missing} />;
    case "signed_out":
      return redirect("/sign-in");
    case "member":
      return redirect("/");
    case "no_lab":
      return <NewLabView email={viewer.user.email} />;
    default: {
      const _exhaustive: never = viewer;
      return _exhaustive;
    }
  }
}
