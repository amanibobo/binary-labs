import { z } from "zod";
import { DeletedView } from "@/app/deleted/deleted-view";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { LabId } from "@/lib/ids";
import type { LabDeletion } from "@/lib/lab-deletion";

const State = z.enum(["pending", "done"]).catch("pending");

const labId = LabId.parse("00000000-0000-4000-8000-0000000000aa");
const requestedAt = "2026-11-04T21:40:00Z";

const DELETIONS: Record<z.infer<typeof State>, LabDeletion> = {
  pending: { kind: "pending", labId, requestedAt },
  done: {
    kind: "done",
    labId,
    requestedAt,
    completedAt: "2026-11-04T21:41:12Z",
    removed: { files: 1977, previews: 612, labels: 1950, protocols: 14, members: 3 },
  },
};

export default async function DeletedFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  return <DeletedView deletion={DELETIONS[State.parse((await searchParams).state)]} />;
}
