import { createScrubber, type KnownPerson } from "./deidentify";
import type { FileKind } from "./domain";
import type { Sha256 } from "./ids";
import { ROLE_LABELS, statusLabel, type ConfirmMethod, type RunFileRole } from "./run-record";
import type { EvidenceTreatment, LeftOutReason, TaskPreview, TaskSource } from "./task-export";

// Builds one run's task folder from its source, de-identified. Pure: the caller reads the
// source and the text files' bytes, and writes what comes back. Everything that leaves goes
// through one scrubber, so "Person A" is the same person in every part and file name.
//
//   question.md  context.md  protocol_as_run.md  protocol_as_written.md  answer_key.md
//   rubric.json  review_notes.md  provenance.json  evidence/NN-<name>  manifest.json

// A text file is read whole to replace names in it; a bigger one can't be checked.
export const MAX_SCRUB_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_FOLDER_BYTES = 1024 * 1024 * 1024;

type SourceFile = TaskSource["files"][number];

export type EvidencePlan = { file: SourceFile; text: boolean; leftOut: LeftOutReason | null };

const TEXT_EXTENSIONS = new Set(["csv", "tsv", "tab", "txt", "md", "json", "xml", "log", "yaml", "yml", "fasta", "fa", "gb"]);
const extensionOf = (name: string) => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");
const looksLikeText = (file: SourceFile) => TEXT_EXTENSIONS.has(extensionOf(file.originalName)) || file.fileKind === "text" || file.mime.startsWith("text/");

const folderOf = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase();
const fieldsOut = (source: Pick<TaskSource, "exclusions">) => new Set(source.exclusions.filter((x) => x.kind === "field").map((x) => x.value));

// Which of the run's files go in, before any byte is read: the caller reads only the text
// files' bytes, and copies the rest from the store unopened.
export function planEvidence(source: Pick<TaskSource, "files" | "exclusions">): EvidencePlan[] {
  const out = fieldsOut(source);
  const folders = source.exclusions.filter((x) => x.kind === "folder").map((x) => folderOf(x.value));
  let total = 0;
  return source.files.map((file) => {
    const text = looksLikeText(file);
    const inFolder = file.paths.some((path) => folders.some((folder) => path.toLowerCase() === folder || path.toLowerCase().startsWith(`${folder}/`)));
    const reason: LeftOutReason | null = !file.kept
      ? "not_kept"
      : out.has(`evidence.${file.fileKind}`)
        ? "kind_excluded"
        : inFolder
          ? "folder_excluded"
          : text && file.size > MAX_SCRUB_BYTES
            ? "too_big_to_check"
            : file.size > MAX_FILE_BYTES || total + file.size > MAX_FOLDER_BYTES
              ? "too_big"
              : null;
    if (reason === null) total += file.size;
    return { file, text, leftOut: reason };
  });
}

// The file's text, or null when it isn't text after all (then it goes in as it is).
export function decodeText(bytes: Uint8Array): string | null {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : null;
  try {
    const text = new TextDecoder(utf16 ?? "utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    if (bytes.includes(0)) return null;
    // An instrument's export in a Western European code page.
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export type EvidenceOut = {
  path: string;
  was: string;
  role: RunFileRole;
  kind: FileKind;
  treatment: EvidenceTreatment;
  sourceSha256: Sha256;
  size: number;
  // The scrubbed copy's text; null for a file copied from the store as it is.
  text: string | null;
};

export type TaskFolder = {
  parts: { path: string; text: string }[];
  evidence: EvidenceOut[];
  leftOut: { was: string; kind: FileKind; role: RunFileRole; reason: LeftOutReason }[];
  counts: { people: number; samples: number; emails: number; replacements: number };
  excluded: string[];
  // Parts that still hold something the scrubber would replace. Empty, or nothing is built.
  leaks: string[];
};

const METHOD_WORDS = { control: "A control", repeat: "A repeat", pi_opinion: "The PI's opinion" } as const satisfies Record<ConfirmMethod, string>;
const FIX_WORDS = { yes: "Yes", no: "No", not_sure: "Not sure" } as const;
const section = (title: string, body: string | null) => (body === null || body.trim() === "" ? [] : [`## ${title}`, "", body.trim(), ""]);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function buildTaskFolder(source: TaskSource, textBytes: ReadonlyMap<Sha256, Uint8Array>): TaskFolder {
  const { run } = source;
  const out = fieldsOut(source);
  const keyOfUser = new Map<string, string>();
  const people: KnownPerson[] = source.people.map((p) => {
    const key = p.personId ?? `user:${p.userId}`;
    if (p.userId !== null) keyOfUser.set(p.userId, key);
    return { key, names: p.names, emails: p.emails };
  });
  const scrubber = createScrubber({ people, removed: [source.lab.name, ...source.exclusions.filter((x) => x.kind === "text").map((x) => x.value)] });
  const t = (text: string | null) => (text === null ? null : scrubber.text(text));
  const who = (personId: string | null) => (personId === null ? null : scrubber.person(personId));
  const user = (userId: string | null) => (userId === null ? null : scrubber.person(keyOfUser.get(userId) ?? `user:${userId}`));

  // The people of the record get their letters first, in a fixed order, so a rebuilt folder
  // names them the same way.
  const ranBy = who(run.personId);
  const confirmer = who(run.confirmedBy);

  const plans = planEvidence(source);
  const evidence: EvidenceOut[] = [];
  const leftOut: TaskFolder["leftOut"] = [];
  for (const plan of plans) {
    const { file } = plan;
    if (plan.leftOut !== null) {
      leftOut.push({ was: file.originalName, kind: file.fileKind, role: file.role, reason: plan.leftOut });
      continue;
    }
    const bytes = plan.text ? textBytes.get(file.sha256) : undefined;
    const text = bytes === undefined ? null : decodeText(bytes);
    evidence.push({
      path: `evidence/${String(evidence.length + 1).padStart(2, "0")}-${scrubber.fileName(file.originalName)}`,
      was: file.originalName,
      role: file.role,
      kind: file.fileKind,
      treatment: text === null ? "as_is" : "scrubbed",
      sourceSha256: file.sha256,
      size: file.size,
      text: text === null ? null : scrubber.text(text),
    });
  }
  const pathOf = (sha256: string | null) => evidence.find((e) => e.sourceSha256 === sha256)?.path ?? null;

  const when = run.startedOn === null ? null : run.endedOn === null || run.endedOn === run.startedOn ? run.startedOn : `${run.startedOn} to ${run.endedOn}`;
  const context = [
    "# Context",
    "",
    `Run: ${t(run.title)}`,
    `How it went: ${statusLabel(run.status)}`,
    ...(when === null ? [] : [`When: ${when}`]),
    ...(run.experiment === null || out.has("experiment") ? [] : [`Experiment: ${t(run.experiment)}`]),
    ...(run.technique === null ? [] : [`Kind of experiment: ${run.technique.label}`]),
    ...(ranBy === null ? [] : [`Run by: ${ranBy}`]),
    ...(run.retryOf === null ? [] : ["This run is another try at an earlier run."]),
    "",
    ...(out.has("debrief") ? [] : [...section("What they were trying to do", t(run.aim)), ...section("What they expected, and what they saw", t(run.expectedSeen))]),
    "## Evidence",
    "",
    ...(evidence.length === 0 ? ["No files."] : evidence.map((e) => `- ${e.path} (${ROLE_LABELS[e.role].toLowerCase()})`)),
    "",
  ];

  const controlPath = pathOf(run.confirmSha256);
  const answerKey = [
    "# Answer key",
    "",
    ...section("Confirmed cause", t(run.confirmedCause)),
    "## How it was confirmed",
    "",
    ...(run.confirmMethod === null ? [] : [`Method: ${METHOD_WORDS[run.confirmMethod]}`]),
    ...(confirmer === null ? [] : [`Confirmed by: ${confirmer}${run.confirmedAt === null ? "" : `, on ${run.confirmedAt.slice(0, 10)}`}`]),
    ...(controlPath === null ? [] : [`The control that showed it: ${controlPath}`]),
    ...(run.confirmNote === null || out.has("confirm_note") ? [] : [`Note: ${t(run.confirmNote)}`]),
    "",
    ...(run.failedStep === null && run.causeCategory === null
      ? []
      : ["## Failure type", "", ...(run.failedStep === null ? [] : [`Step that went wrong: ${run.failedStep.label}`]), ...(run.causeCategory === null ? [] : [`Kind of problem: ${run.causeCategory.label}`]), ""]),
    ...(out.has("suspected_cause") ? [] : section("Suspected before it was confirmed", t(run.suspectedCause))),
    ...(out.has("debrief")
      ? []
      : [...section("How they found out", t(run.howFound)), ...section("What they changed", t(run.whatChanged)), ...section("Did the change fix it", run.fixWorked === null ? null : FIX_WORDS[run.fixWorked])]),
  ];

  const asRun =
    run.asRunBody !== null
      ? ["# Protocol as run", "", t(run.asRunBody) ?? ""]
      : ["# Protocol as run", "", "No changes from the written protocol were recorded for this run.", "", t(source.planned?.body ?? "") ?? ""];

  const rubric = source.task?.rubric.map((item) => ({ criterion: scrubber.text(item.criterion), points: item.points })) ?? [];
  const reviews = source.reviews.map((review) => ({ ...review, reviewer: who(review.reviewerId) }));

  const parts: TaskFolder["parts"] = [
    { path: "question.md", text: ["# Question", "", t(source.task?.question ?? "") ?? "", ""].join("\n") },
    { path: "context.md", text: context.join("\n") },
    { path: "protocol_as_run.md", text: `${asRun.join("\n").trimEnd()}\n` },
    ...(source.planned === null || out.has("protocol_as_written")
      ? []
      : [{ path: "protocol_as_written.md", text: `# Protocol as written\n\n${t(source.planned.title)}, version ${source.planned.version}\n\n${(t(source.planned.body) ?? "").trimEnd()}\n` }]),
    { path: "answer_key.md", text: `${answerKey.join("\n").trimEnd()}\n` },
    { path: "rubric.json", text: json({ total_points: rubric.reduce((sum, item) => sum + item.points, 0), criteria: rubric }) },
    {
      path: "review_notes.md",
      text: `${[
        "# Review notes",
        "",
        ...reviews.flatMap((review) => [
          `## ${review.reviewer ?? "A second scientist"}, ${review.reviewedAt.slice(0, 10)}`,
          "",
          `Agrees with the confirmed cause: ${review.agrees === null ? "Not said" : review.agrees ? "Yes" : "No"}`,
          "",
          scrubber.text(review.notes).trim(),
          "",
        ]),
      ]
        .join("\n")
        .trimEnd()}\n`,
    },
    {
      path: "provenance.json",
      text: json({
        run: { id: run.id, run_by: ranBy, status: run.status, status_set_by: user(run.statusBy), status_set_at: run.statusAt },
        cause: {
          confirmed_by: confirmer,
          method: run.confirmMethod,
          confirmed_at: run.confirmedAt,
          typed_in_by: user(run.confirmRecordedBy),
          confirmer_said_so_at: run.confirmerAttestedAt,
          confirming_run: run.confirmRun,
          confirming_file: controlPath,
          others_who_could_confirm: out.has("debrief") ? null : t(run.whoElse),
        },
        protocol: { as_run_written_by: user(run.asRunBy), as_run_written_at: run.asRunAt },
        task: {
          question_and_rubric_by: user(source.task?.writtenBy ?? null),
          written_at: source.task?.writtenAt ?? null,
          reviews: reviews.map((review) => ({ reviewer: review.reviewer, typed_in_by: user(review.recordedBy), reviewed_at: review.reviewedAt, agrees: review.agrees })),
        },
        sharing: { lab_agreement: source.lab.agreement, lab_agreed_at: source.lab.agreedAt, lab_agreed_by: user(source.lab.agreedBy) },
        history: source.log.map((entry) => ({ at: entry.at, action: entry.action, by: user(entry.actor), via: entry.via, ...(entry.action === "run.share" ? { share: entry.share } : { changed: entry.changed }) })),
      }),
    },
  ];

  const leaks = [...parts.filter((p) => !scrubber.isClean(p.text)).map((p) => p.path), ...evidence.filter((e) => !scrubber.isClean(e.path) || (e.text !== null && !scrubber.isClean(e.text))).map((e) => e.path)];
  return { parts, evidence, leftOut, counts: scrubber.counts(), excluded: [...out].sort(), leaks };
}

// The de-identified record as a person checks it before building: every written part in
// full, and the top of each scrubbed file.
export function previewOf(source: TaskSource, folder: TaskFolder): TaskPreview {
  return {
    reasons: [...source.blocks, ...source.gaps],
    parts: folder.parts,
    evidence: folder.evidence.map((e) => ({
      path: e.path,
      was: e.was,
      role: e.role,
      kind: e.kind,
      treatment: e.treatment,
      bytes: e.size,
      sourceSha256: e.sourceSha256,
      excerpt: e.text === null ? null : e.text.split("\n").slice(0, 12).join("\n").slice(0, 1200),
    })),
    leftOut: folder.leftOut.map(({ was, kind, reason }) => ({ was, kind, reason })),
    counts: folder.counts,
    excluded: folder.excluded,
  };
}
