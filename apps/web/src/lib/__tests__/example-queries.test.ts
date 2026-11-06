import { describe, expect, it } from "vitest";
import { PLAIN_LABEL, type Experiment, type Label, type Person } from "../domain";
import { exampleQueries } from "../example-queries";
import { ExperimentId, PersonId } from "../ids";

const experiment = (n: number, name: string): Experiment => ({ id: ExperimentId.parse(`00000000-0000-4000-8000-0000000000e${n}`), name, aliases: [] });
const person = (n: number, name: string): Person => ({ id: PersonId.parse(`00000000-0000-4000-8000-0000000000a${n}`), name, aliases: [] });

const bm3 = experiment(1, "P450 BM3");
const screen = experiment(2, "Solubility screen");
const rotation = experiment(3, "Rotation projects");
const priya = person(1, "Priya Nair");
const ade = person(2, "Ade Okafor");

const base: Label = { ...PLAIN_LABEL, status: "suggested", cleanName: "x", date: null, experiment: null, person: null, instrument: null, tags: [], confidence: 0.9 };
const labeled = (details: Partial<Pick<Label, "experiment" | "person" | "instrument">>) => ({ label: { ...base, ...details } });
const empty = { experiments: [], people: [] };

describe("exampleQueries", () => {
  it("takes an experiment, a person and an instrument from recent files in turn", () => {
    const recent = [
      labeled({ experiment: bm3, person: priya, instrument: "ChemiDoc" }),
      labeled({ experiment: screen, instrument: "Plate reader" }),
      { label: null },
    ];
    expect(exampleQueries(recent, empty)).toEqual(["P450 BM3", "Priya Nair", "ChemiDoc", "Solubility screen"]);
  });

  it("names each thing once, ignoring case, and fills up from the lab's lists", () => {
    const recent = [labeled({ experiment: bm3 }), labeled({ experiment: bm3, instrument: "p450 bm3" })];
    expect(exampleQueries(recent, { experiments: [bm3, screen, rotation], people: [ade] })).toEqual([
      "P450 BM3",
      "Ade Okafor",
      "Solubility screen",
      "Rotation projects",
    ]);
  });

  it("returns fewer when the lab has little to go on, and none for a new lab", () => {
    expect(exampleQueries([], { experiments: [screen], people: [] })).toEqual(["Solubility screen"]);
    expect(exampleQueries([{ label: null }], empty)).toEqual([]);
  });
});
