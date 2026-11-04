import { notFound } from "next/navigation";

// Fixture pages also need BINARY_LABS_FIXTURES=1, so a plain `next dev` doesn't serve them.
export function requireFixtures(): void {
  if (process.env.NODE_ENV !== "development" || process.env.BINARY_LABS_FIXTURES !== "1") notFound();
}

// Dev-only routes aren't in the typed route list that production typegen builds.
export type FixtureProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };
