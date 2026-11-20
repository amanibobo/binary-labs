import { z } from "zod";
import { LocationId, Sha256 } from "./ids";
import { fromRow } from "./run-record";

// One of a run's files whose place in the lab's folder holds a later version now
// (run_edited_files). The run still opens its own version; the place's history shows both.
export const EditedFile = z.object({
  sha256: Sha256,
  locationId: LocationId,
  // The version at that place that is the run's content, and when the source says it was saved.
  heldVersion: z.number().int().positive(),
  heldAt: z.string(),
  latestVersion: z.number().int().positive(),
  latestAt: z.string(),
});
export type EditedFile = z.infer<typeof EditedFile>;

export const EditedFilesJson = fromRow(z.array(EditedFile));
