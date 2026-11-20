import "server-only";
import { NextResponse } from "next/server";
import type { LabId } from "./ids";
import { logError } from "./log";
import { discardStaging, putFile, readObject } from "./object-store";
import { runFailure } from "./run-record";
import type { FolderStore } from "./task-folder-store";

// The app's store, as the task folder uses it.
export const objectStore: FolderStore = { read: readObject, put: putFile, remove: discardStaging };

const FAILURES: Readonly<Record<string, { status: number; message: string }>> = {
  "42501": { status: 403, message: "Only an admin of this lab can do that." },
  BL961: { status: 400, message: "The reviewer has to be someone other than the person who ran this." },
  BL962: { status: 400, message: "The cause has to be confirmed, and the person who confirmed it has to say so, before a task is written." },
  BL963: { status: 400, message: "A rubric is 1 to 20 lines, each worth 1 to 10 points." },
  BL966: { status: 400, message: "That isn't something a lab can leave out." },
  "23514": { status: 400, message: "Write the question and the review notes before saving." },
};

// A database error from a task function, as the browser should see it.
export function taskError(error: { code?: string; message: string }, ctx: { event: string; labId: LabId }): NextResponse {
  const failure = FAILURES[error.code ?? ""] ?? runFailure(error);
  if (failure.status === 500) logError(ctx.event, { labId: ctx.labId, error });
  return NextResponse.json({ error: failure.message }, { status: failure.status, headers: { "cache-control": "private, no-store" } });
}
