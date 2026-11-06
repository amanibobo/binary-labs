"use client";

import { useState, type ReactNode } from "react";
import { CalendarApiProvider } from "@/components/calendar/calendar-api";
import { createFixtureCalendar } from "./calendar";

// The calendar's API for the fixture pages: canned data, writes kept in the page.
export function FixtureCalendar({ children }: { children: ReactNode }) {
  const [api] = useState(createFixtureCalendar);
  return <CalendarApiProvider value={api}>{children}</CalendarApiProvider>;
}
