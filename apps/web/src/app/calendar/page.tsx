import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { CalendarScreen } from "@/components/calendar/calendar-screen";
import { ConfigMissing } from "@/components/config-missing";
import { calendarStart } from "@/lib/calendar-start";
import { loadAuthorNames, loadExperiments, loadInstruments, loadPeople, loadProtocols } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const start = calendarStart(await searchParams);
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, experiments, people, instruments, protocols, authors] = await Promise.all([
    loadShell(viewer),
    loadExperiments(supabase, lab.id),
    loadPeople(supabase, lab.id),
    loadInstruments(supabase, lab.id),
    loadProtocols(supabase, lab.id),
    loadAuthorNames(supabase, lab.id),
  ]);
  return (
    <AppShell shell={shell} location={{ section: "calendar" }}>
      <CalendarScreen
        start={start}
        viewer={viewer.user.id}
        lists={{
          experiments,
          people,
          instruments: instruments.map((i) => ({ id: i.id, name: i.name, live: i.state.kind !== "revoked" })),
          protocols: protocols.map((p) => ({ id: p.id, title: p.title })),
          authors,
        }}
      />
    </AppShell>
  );
}
