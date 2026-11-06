import { AppShell } from "@/components/app-shell";
import { CalendarScreen } from "@/components/calendar/calendar-screen";
import { FixtureCalendar } from "@/fixtures/calendar-api";
import { CALENDAR_NOW, CALENDAR_TODAY, CALENDAR_ZONE, calendarLists } from "@/fixtures/calendar";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { calendarStart } from "@/lib/calendar-start";

// The lab calendar on November 2026 in New York, the week the clocks went back. Takes the
// page's own parameters: ?view=day|week|month|year, &date=, &day= (a day opened), &entry= (one
// in the side peek). The clock is pinned to 10:20 am on Nov 5 so screenshots hold still.
export default async function CalendarFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const params = await searchParams;
  const start = calendarStart({ date: CALENDAR_TODAY, ...params });
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <FixtureCalendar>
        <AppShell shell={fixtureShell} location={{ section: "calendar" }}>
          <CalendarScreen start={start} lists={calendarLists} viewer="fixture" timeZone={CALENDAR_ZONE} now={CALENDAR_NOW} />
        </AppShell>
      </FixtureCalendar>
    </FixtureLabApi>
  );
}
