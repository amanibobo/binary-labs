import { describe, expect, it } from "vitest";
import { createFixtureExport } from "@/fixtures/task-export";
import { FIRST_TRY } from "@/fixtures/runs";
import { Sha256 } from "../ids";
import type { TaskSource } from "../task-export";
import { decodeText, MAX_FILE_BYTES, MAX_FOLDER_BYTES, MAX_SCRUB_BYTES, planEvidence } from "../task-folder";

const signal = new AbortController().signal;

describe("the fixture page's record", () => {
  it("is made by the real de-identifier, and holds none of the lab's names", async () => {
    const api = createFixtureExport("written");
    const preview = await api.preview(FIRST_TRY, signal);
    const everything = [...preview.parts.flatMap((p) => [p.path, p.text]), ...preview.evidence.flatMap((e) => [e.path, e.excerpt ?? ""])].join("\n").toLowerCase();
    for (const name of ["priya", "nair", "jordan", "morales", "okafor", "pn-042", "@university.edu"]) expect(everything, name).not.toContain(name);
    expect(everything).not.toMatch(/\b(ade|jm|pn|ao)\b/);
    expect(preview.parts.map((p) => p.path)).toEqual(["question.md", "context.md", "protocol_as_run.md", "protocol_as_written.md", "answer_key.md", "rubric.json", "review_notes.md", "provenance.json"]);
    expect(preview.evidence.map((e) => [e.path, e.treatment])).toEqual([
      ["evidence/01-Person A_gel_lanes_2026-10-15.csv", "scrubbed"],
      ["evidence/02-Sample 1 BM3 gel.tif", "as_is"],
      ["evidence/03-ladder standards.xlsx", "as_is"],
    ]);
    expect(preview.evidence[0]?.excerpt).toBe("lane,sample,operator,band_kDa\n1,Sample 1 uninduced,Person A,\n2,Sample 1 induced 4 h,Person A,\n3,ladder,,119\n");
    expect(preview.counts).toMatchObject({ people: 3, samples: 1 });
    // The answer stays out of what a solver is given.
    const context = preview.parts.find((p) => p.path === "context.md")?.text ?? "";
    expect(context).not.toContain("IPTG");
    expect(context).not.toContain("Induction");
    expect(preview.parts.find((p) => p.path === "answer_key.md")?.text).toContain("Step that went wrong: Induction");
  });

  it("leaves a kind of file out once the lab says so, and blocks a build that isn't ready", async () => {
    const api = createFixtureExport("waiting");
    const preview = await api.preview(FIRST_TRY, signal);
    expect(preview.leftOut).toEqual([{ was: "PN-042 BM3 gel.tif", kind: "image", reason: "kind_excluded" }]);
    expect(preview.reasons).toEqual(["run_off", "not_attested", "no_task", "no_review"]);
    expect(await api.build(FIRST_TRY)).toEqual({ kind: "blocked", reasons: ["run_off", "not_attested", "no_task", "no_review"] });
  });
});

describe("which files go in", () => {
  const file = (n: number, over: Partial<TaskSource["files"][number]>): TaskSource["files"][number] => ({
    sha256: Sha256.parse(String(n).repeat(64)),
    role: "evidence",
    fileKind: "other",
    mime: "application/octet-stream",
    size: 10,
    originalName: `f${n}.bin`,
    kept: true,
    paths: [`/Lab/f${n}.bin`],
    ...over,
  });
  const plan = (files: TaskSource["files"], exclusions: TaskSource["exclusions"] = []) =>
    planEvidence({ files, exclusions } as TaskSource).map((p) => [p.text, p.leftOut]);

  it("reads text files to scrub them, and leaves out one too big to check", () => {
    expect(
      plan([
        file(1, { originalName: "a.csv", size: MAX_SCRUB_BYTES }),
        file(2, { originalName: "b.CSV", size: MAX_SCRUB_BYTES + 1 }),
        file(3, { mime: "text/plain" }),
        file(4, { fileKind: "text" }),
        file(5, { originalName: "gel.tif" }),
      ]),
    ).toEqual([[true, null], [true, "too_big_to_check"], [true, null], [true, null], [false, null]]);
  });

  it("leaves out a file that isn't kept, is too big, or would take the folder past its size", () => {
    expect(
      plan([
        file(1, { kept: false }),
        file(2, { size: MAX_FILE_BYTES + 1 }),
        ...[3, 4, 5, 6, 7].map((n) => file(n, { size: MAX_FILE_BYTES })),
        file(8, { size: MAX_FOLDER_BYTES - 5 * MAX_FILE_BYTES }),
        file(9, { size: 1 }),
      ]).map(([, reason]) => reason),
    ).toEqual(["not_kept", "too_big", null, null, null, null, null, null, "too_big"]);
  });

  it("matches an excluded folder by whole path segments, whatever its case", () => {
    const files = [file(1, { paths: ["/Lab/People/x.bin"] }), file(2, { paths: ["/Lab/Peoples/x.bin"] }), file(3, { paths: ["/Other/x.bin", "/lab/people/old/x.bin"] })];
    expect(plan(files, [{ kind: "folder", value: "/Lab/People/" }]).map(([, reason]) => reason)).toEqual(["folder_excluded", null, "folder_excluded"]);
  });
});

describe("reading a text file", () => {
  it("reads UTF-8, UTF-16 with a mark and a Western code page, and refuses binary", () => {
    expect(decodeText(new TextEncoder().encode("Zoë,1"))).toBe("Zoë,1");
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x5a, 0x00, 0x6f, 0x00]))).toBe("Zo");
    expect(decodeText(new Uint8Array([0x5a, 0x6f, 0xeb]))).toBe("Zoë");
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x00, 0xff]))).toBeNull();
    expect(decodeText(new Uint8Array([0x41, 0x00, 0x42]))).toBeNull();
  });
});
