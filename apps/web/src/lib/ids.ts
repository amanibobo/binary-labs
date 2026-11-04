import { z } from "zod";

export const LabId = z.uuid().brand<"LabId">();
export type LabId = z.infer<typeof LabId>;

export const SourceId = z.uuid().brand<"SourceId">();
export type SourceId = z.infer<typeof SourceId>;

export const UserId = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof UserId>;

export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256")
  .brand<"Sha256">();
export type Sha256 = z.infer<typeof Sha256>;
