import type { DebriefId, LocationId, RunId } from "@/lib/ids";
import type { RunFix, RunRecord } from "@/lib/run-record";
import { notBuilt } from "./http";

// Slice D, the spoken or typed debrief (brief item 5). The foundation typed this interface
// and left the bodies; the slice fills them in and owns this file from then on.

export type DebriefQuestion = 1 | 2 | 3 | 4 | 5 | 6;

// One answer to one question: the scientist's own words, as a recording's transcript or as
// typed. Nothing here is written by a model.
export type DebriefAnswer = {
  question: DebriefQuestion;
  // Null while a recording is still being transcribed.
  text: string | null;
  typed: boolean;
  // The recording, to play beside its transcript.
  audio: LocationId | null;
  // Question 5 only: the Yes / No / Not sure tap.
  fixWorked: RunFix | null;
};

export type Debrief = {
  id: DebriefId;
  runId: RunId;
  state: "open" | "approved" | "discarded";
  // The questions answered so far; one left out reads "missing".
  answers: DebriefAnswer[];
};

export type DebriefApi = {
  // The run's open debrief, if someone has started one.
  debrief: (runId: RunId, signal: AbortSignal) => Promise<Debrief | null>;
  startDebrief: (runId: RunId) => Promise<Debrief>;
  recordAnswer: (id: DebriefId, question: DebriefQuestion, audio: Blob) => Promise<Debrief>;
  // A typed answer, or the scientist's correction of a transcript.
  saveAnswerText: (id: DebriefId, question: DebriefQuestion, text: string) => Promise<Debrief>;
  setFixWorked: (id: DebriefId, fix: RunFix | null) => Promise<Debrief>;
  // The scientist approves: each answer becomes its field on the run.
  approveDebrief: (id: DebriefId) => Promise<RunRecord>;
  discardDebrief: (id: DebriefId) => Promise<void>;
};

export const httpDebriefApi: DebriefApi = {
  debrief: notBuilt,
  startDebrief: notBuilt,
  recordAnswer: notBuilt,
  saveAnswerText: notBuilt,
  setFixWorked: notBuilt,
  approveDebrief: notBuilt,
  discardDebrief: notBuilt,
};
