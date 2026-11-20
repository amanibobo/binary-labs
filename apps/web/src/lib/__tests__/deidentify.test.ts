import { describe, expect, it } from "vitest";
import { createScrubber, REMOVED, type DeidRules } from "../deidentify";

const rules: DeidRules = {
  people: [
    { key: "p1", names: ["Priya Nair", "PN", "Priya"], emails: ["priya.n@university.edu"] },
    { key: "p2", names: ["Jordan Morales", "JM"], emails: ["j.morales@university.edu"] },
    { key: "p3", names: ["Mark Will"], emails: [] },
    { key: "p4", names: ["Zoë Müller-Åberg"], emails: [] },
    { key: "p5", names: ["王伟"], emails: [] },
    { key: "p6", names: ["Siobhán O'Brien", "Li"], emails: [] },
  ],
  removed: ["Okafor Lab", "Project Nightjar"],
};
const scrub = (text: string) => createScrubber(rules).text(text);

describe("names in text", () => {
  it.each([
    ["Priya Nair ran the gel.", "Person A ran the gel."],
    ["Nair, Priya ran it", "Person A ran it"],
    ["ask priya about it", "ask Person A about it"],
    ["PRIYA NAIR", "Person A"],
    ["Priya's plate and Nair's buffer", "Person A's plate and Person A's buffer"],
    ["P. Nair confirmed", "Person A confirmed"],
    ["PriyaNair_notes", "Person A_notes"],
    ["login pnair on the reader", "login Person A on the reader"],
    ["Zoe Muller-Aberg and ZOË MÜLLER", "Person A and Person A"],
    ["Zoë said so", "Person A said so"],
    ["由王伟确认", "由Person A确认"],
    ["Siobhan OBrien and O'Brien", "Person A and Person A"],
    ["Li ran it; LI agreed", "Person A ran it; Person A agreed"],
  ])("%s", (input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it("gives each person one placeholder for the whole folder, in the order met", () => {
    const s = createScrubber(rules);
    expect(s.text("Jordan asked Priya.")).toBe("Person A asked Person B.");
    expect(s.text("Nair told JM.")).toBe("Person B told Person A.");
    expect(s.person("p2")).toBe("Person A");
    expect(s.person("p3")).toBe("Person C");
    expect(s.counts()).toMatchObject({ people: 3, replacements: 4 });
  });

  it("leaves words that only look like a name", () => {
    expect(scrub("mark the plate, it will run at pH 7 in buffer")).toBe("mark the plate, it will run at pH 7 in buffer");
    expect(scrub("An aliquot of lithium (li) in PNG format, japan, primer")).toBe("An aliquot of lithium (li) in PNG format, japan, primer");
    expect(scrub("Mark ran it. Ask WILL.")).toBe("Person A ran it. Ask Person A.");
  });

  it("takes initials only as they are written", () => {
    expect(scrub("PN and JM set it up")).toBe("Person A and Person B set it up");
    expect(scrub("Pn pN jm")).toBe("Pn pN jm");
    expect(scrub("gel_pn_final")).toBe("gel_Person A_final");
  });
});

describe("emails", () => {
  it("replaces a member's email with their placeholder and any other with a numbered one", () => {
    const s = createScrubber(rules);
    expect(s.text("Mail Priya.N@University.edu or core@facility.org, then core@facility.org again")).toBe("Mail Person A or Email 1, then Email 1 again");
    expect(s.text("j.morales at the bench; morales")).toBe("j.Person B at the bench; Person B");
  });
});

describe("sample IDs tied to people", () => {
  it("replaces a name or initials joined to a number, the same one each time", () => {
    const s = createScrubber(rules);
    expect(s.text("Lanes: PN-042, PN042, JM_7 and pn-042")).toBe("Lanes: Sample 1, Sample 1, Sample 2 and Sample 1");
    expect(s.text("tube 17_Nair, nair3b")).toBe("tube Sample 3, Sample 4");
    expect(s.counts().samples).toBe(4);
  });

  it("replaces patient, donor and subject numbers", () => {
    expect(scrub("Blood from Patient 12 and donor-3; patient ID: A77; MRN 0045812")).toBe("Blood from Sample 1 and Sample 2; Sample 3; Sample 4");
  });

  it("keeps a date beside a name as a date", () => {
    expect(scrub("PN_2026-10-14_gel and 2026-10-14_PN and PN_14-10-2026")).toBe("Person A_2026-10-14_gel and 2026-10-14_Person A and Person A_14-10-2026");
    expect(scrub("plate7_PN")).toBe("plate7_Person A");
  });
});

describe("what the lab marked", () => {
  it("removes the phrase however it is spaced or cased, and only as whole words", () => {
    expect(scrub("From the Okafor Lab: project_nightjar, PROJECT-NIGHTJAR.")).toBe(`From the ${REMOVED}: ${REMOVED}, ${REMOVED}.`);
    expect(scrub("projectnightjars")).toBe("projectnightjars");
  });
});

describe("file names", () => {
  it.each([
    ["Priya_Nair_gel_2026-10-14.CSV", "Person A_gel_2026-10-14.csv"],
    ["pn_plate7.xlsx", "Person A_plate7.xlsx"],
    ["will_gel.png", "Person A_gel.png"],
    ["will gel.png", "Person A gel.png"],
    ["JM-0042 westerns.tif", "Sample 1 westerns.tif"],
    ["Project Nightjar/../plan.md", "removed_.._plan.md"],
    ["priya.n@university.edu.txt", "Person A.txt"],
    ["Nair", "Person A"],
    ["...", "file"],
  ])("%s", (input, expected) => {
    expect(createScrubber(rules).fileName(input)).toBe(expected);
  });
});

// Names in odd places, generated: every spelling of every person, dropped into file names,
// CSV cells and a transcript, must be gone from what comes out.
describe("no name survives", () => {
  const FIRST = ["Aroha", "Bjørn", "Chidi", "Dagny", "Emeka", "Farrukh", "Gwenllian", "Hyun-woo", "Ignác", "Jacinta", "Kwabena", "Lorcán"];
  const LAST = ["Ngata", "Halvorsen", "Okonkwo", "Þórsdóttir", "Eze", "Tashkentov", "ap Rhys", "Seong", "Dvořák", "Rangihuna", "Asante", "Ó Súilleabháin"];
  let seed = 20261120;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pick = <T,>(xs: readonly T[]): T => {
    const x = xs[rand(xs.length)];
    if (x === undefined) throw new Error("nothing to pick from");
    return x;
  };
  const bare = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

  const people = FIRST.map((first, i) => {
    const last = LAST[i] ?? "Unnamed";
    const login = bare(first.charAt(0) + last).replace(/[^a-z]/g, "");
    return { key: `p${i}`, first, last, login, names: [`${first} ${last}`], emails: [`${login}@lab.example`] };
  });
  const fuzzRules: DeidRules = { people, removed: [] };

  const spellings = (p: (typeof people)[number]) => [
    `${p.first} ${p.last}`,
    `${p.last}, ${p.first}`,
    `${p.first}${p.last}`.replace(/\s/g, ""),
    `${p.first}_${p.last}`.replace(/\s/g, "_"),
    `${p.first}.${p.last}`.toLowerCase().replace(/\s/g, "."),
    `${p.first} ${p.last}`.toUpperCase(),
    bare(`${p.first} ${p.last}`),
    p.first,
    p.last,
    `${p.last}'s`,
    `${p.first.charAt(0)}. ${p.last}`,
    p.login,
    `${p.login}@lab.example`,
    `${p.last}-0${rand(90) + 10}`,
    `${rand(90) + 10}_${p.first}`,
  ];
  const frames = [
    (x: string) => `${x}_gel_2026-10-14.csv`,
    (x: string) => `scan ${x}.tif`,
    (x: string) => `2026-10-14-${x}-plate7.xlsx`,
    (x: string) => `well,od600,operator\nA1,0.42,${x}\nA2,0.44,"${x}"`,
    (x: string) => `sample\tby\n${x}\t${x}`,
    (x: string) => `So, um, ${x} set up the plate and then ${x} said the lysate looked cloudy.`,
    (x: string) => `(${x})[${x}]{"by":"${x}"}`,
    (x: string) => `Confirmed by ${x}; cc ${x}.`,
  ];
  // What must not be left: each word of the name of three letters or more, and the login,
  // with and without accents.
  const traces = (p: (typeof people)[number]) =>
    [...`${p.first} ${p.last}`.split(/[^\p{L}]+/u), p.login].filter((w) => w.length >= 3).flatMap((w) => [w.toLowerCase(), bare(w)]);

  it("in 3,000 generated file names, cells and transcript lines", () => {
    const s = createScrubber(fuzzRules);
    for (let i = 0; i < 3000; i++) {
      const p = pick(people);
      const input = pick(frames)(pick(spellings(p)));
      const isName = !input.includes("\n") && /\.\w{2,4}$/.test(input);
      const output = isName ? s.fileName(input) : s.text(input);
      const lowered = output.toLowerCase();
      for (const trace of traces(p)) {
        if (lowered.includes(trace) || bare(output).includes(trace)) throw new Error(`"${trace}" survived: ${JSON.stringify(input)} became ${JSON.stringify(output)}`);
      }
      expect(s.isClean(output)).toBe(true);
    }
    expect(s.counts().people).toBe(people.length);
  });
});
