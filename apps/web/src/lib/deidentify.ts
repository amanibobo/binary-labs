// De-identification for anything that leaves the lab (decisions.md, "the run record:
// de-identification and the task folder"). Pure: text in, text out, no reads.
//
// One scrubber serves one folder, so a placeholder means the same person or sample everywhere
// in it: "Person A" in the answer key is "Person A" in a file's name. It finds what the lab
// knows (its people's names, other spellings and emails, and what it marked to remove), any
// email address, and sample IDs tied to a person. A name the lab has never recorded can't be
// found, which is why a person reads the preview before anything is built.

export type KnownPerson = {
  // Stable within the lab: a people id or a user id.
  key: string;
  // The display name and other spellings, initials included.
  names: readonly string[];
  emails: readonly string[];
};

export type DeidRules = {
  people: readonly KnownPerson[];
  // Words and phrases the lab marked to remove, and the lab's own name.
  removed: readonly string[];
};

export type ScrubCounts = { people: number; samples: number; emails: number; replacements: number };

export type Scrubber = {
  text: (input: string) => string;
  // A file's name with its extension kept, safe as one path segment.
  fileName: (name: string) => string;
  // The placeholder of someone named by id rather than in text.
  person: (key: string) => string;
  // Nothing this scrubber would replace is left in the text.
  isClean: (input: string) => boolean;
  counts: () => ScrubCounts;
};

export const REMOVED = "[removed]";

// Names that are also everyday words. In lower case inside a sentence they are read as the
// word ("mark the plate"); capitalized, or joined into a file name, as the name.
const EVERYDAY = new Set(
  "will mark may bill grant young long white brown green black gray grey rose june april august summer hunter page read wells banks field fields park parks bell cook hill king wood woods stone snow frost best small little strong sharp bright fox wolf lamb bird fish rice pepper berry cotton glass steel gold silver baker cooper carter miller mason taylor walker turner fisher weaver major price rush chase chance hope grace faith dawn lane dean drew rich wang case ball cross wall west north south east love star stark power powers light knight nurse".split(
    " ",
  ),
);

const letter = /\p{L}/u;
const upper = /\p{Lu}/u;
const isLetter = (c: string | undefined) => c !== undefined && letter.test(c);
const isUpper = (c: string | undefined) => c !== undefined && upper.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Lower case without accents, one character for one, so a position in the folded text is the
// same position in the original.
function fold(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    const bare = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out += bare.length === 1 ? bare : c;
  }
  return out;
}

const partsOf = (name: string) => fold(name.normalize("NFC")).split(/[^\p{L}\p{N}]+/u).filter((p) => p !== "");

type Target = { kind: "person"; key: string } | { kind: "sample" } | { kind: "email" } | { kind: "removed" };
type Span = { start: number; end: number; target: Target; rank: number };

// A term is a name or part of one. A `careful` term (three letters or fewer, or an everyday
// word) in lower case counts only where it is joined to something, as in a file name;
// `initials` (given in capitals, like "PN") never match "Pn" or "pN". A name in a script
// without capitals has no word edges to check.
type Term = { key: string; pattern: RegExp; careful: boolean; capitals: boolean; caseless: boolean; initials: string };

const SEPARATORS = "[\\s._,'-]*";
const SUBJECT = /(?<![\p{L}\p{N}])(?:patient|subject|donor|participant|volunteer|mrn)(?:[\s#:_.-]*(?:id|no|number))?[\s#:_.-]*[a-z]{0,3}\d[\p{L}\p{N}-]*/gu;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;
const looksLikeADate = (digits: string) => /^(?:19|20)\d{2}$/.test(digits) || /^(?:19|20)\d{6}$/.test(digits);

function letters(index: number): string {
  let out = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) out = String.fromCharCode(65 + (n % 26)) + out;
  return out;
}

export function createScrubber(rules: DeidRules): Scrubber {
  const personOf = new Map<string, string>();
  const sampleOf = new Map<string, string>();
  const emailOf = new Map<string, string>();
  let replacements = 0;

  const person = (key: string) => {
    const known = personOf.get(key);
    if (known !== undefined) return known;
    const made = `Person ${letters(personOf.size)}`;
    personOf.set(key, made);
    return made;
  };
  const numbered = (map: Map<string, string>, word: string, key: string) => {
    const known = map.get(key);
    if (known !== undefined) return known;
    const made = `${word} ${map.size + 1}`;
    map.set(key, made);
    return made;
  };

  const knownEmails = new Map<string, string>();
  const fullNames: Term[] = [];
  const singles: Term[] = [];
  const seen = new Set<string>();
  const caseless = (s: string) => s.toLowerCase() === s.toUpperCase();
  function addSingle(key: string, part: string, raw: string, initials: string) {
    if (part.length < 2 || !isLetter(part.charAt(0)) || seen.has(`${key}:${part}`)) return;
    seen.add(`${key}:${part}`);
    singles.push({
      key,
      pattern: new RegExp(escape(part), "gu"),
      careful: part.length <= 3 || EVERYDAY.has(part),
      capitals: raw.length <= 3 && raw === raw.toUpperCase() && !caseless(raw),
      caseless: caseless(raw),
      initials,
    });
  }
  for (const p of rules.people) {
    for (const email of p.emails) {
      knownEmails.set(fold(email.trim()), p.key);
      // "priya.nair@..." names its owner before the @ too.
      for (const part of partsOf(email.split("@")[0] ?? "")) {
        if (part.length >= 4 && !/\d/.test(part)) addSingle(p.key, part, part, "");
      }
    }
    for (const name of p.names) {
      const raw = name.normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((part) => part !== "");
      const parts = raw.map(fold);
      const initials = parts.map((part) => part.charAt(0)).join("");
      const first = parts[0];
      const last = parts[parts.length - 1];
      if (parts.length > 1 && first !== undefined && last !== undefined) {
        for (const order of [parts, [...parts].reverse()]) {
          fullNames.push({ key: p.key, pattern: new RegExp(order.map(escape).join(SEPARATORS), "gu"), careful: false, capitals: false, caseless: caseless(name), initials: "" });
        }
        // "pnair" and "priyan", as in a login.
        addSingle(p.key, first.charAt(0) + last, first.charAt(0) + last, "");
        addSingle(p.key, first + last.charAt(0), first + last.charAt(0), "");
      }
      parts.forEach((part, i) => addSingle(p.key, part, raw[i] ?? part, initials));
    }
  }
  const removed = rules.removed
    .map(partsOf)
    .filter((parts) => parts.length > 0)
    .map((parts) => new RegExp(parts.map(escape).join("[\\s._,'-]*"), "gu"));

  // Where a word starts or ends: beside anything that isn't a letter, or at a change of case
  // ("PriyaNair" is two words).
  const startsWord = (text: string, at: number) => !isLetter(text[at - 1]) || (!isUpper(text[at - 1]) && isUpper(text[at]));
  const endsWord = (text: string, end: number) => !isLetter(text[end]) || (isUpper(text[end]) && !isUpper(text[end - 1]));
  const joined = (text: string, at: number, end: number) => /[_-]/.test(text[at - 1] ?? " ") || /[_-]/.test(text[end] ?? " ");

  function spans(text: string, loose: boolean): Span[] {
    const folded = fold(text);
    const found: Span[] = [];
    const each = (pattern: RegExp, visit: (start: number, end: number) => void) => {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(folded); m !== null; m = pattern.exec(folded)) {
        if (m[0].length === 0) pattern.lastIndex += 1;
        else visit(m.index, m.index + m[0].length);
      }
    };

    for (const pattern of removed) {
      each(pattern, (start, end) => {
        if (startsWord(text, start) && endsWord(text, end) && !isDigit(text[start - 1]) && !isDigit(text[end])) found.push({ start, end, target: { kind: "removed" }, rank: 0 });
      });
    }
    each(EMAIL, (start, end) => found.push({ start, end, target: { kind: "email" }, rank: 1 }));
    each(SUBJECT, (start, end) => found.push({ start, end, target: { kind: "sample" }, rank: 2 }));
    const edged = (term: Term, start: number, end: number) => term.caseless || (startsWord(text, start) && endsWord(text, end));
    for (const term of fullNames) {
      each(term.pattern, (start, end) => {
        if (edged(term, start, end)) found.push({ start, end, target: { kind: "person", key: term.key }, rank: 3 });
      });
    }
    for (const term of singles) {
      each(term.pattern, (start, end) => {
        if (!edged(term, start, end)) return;
        const form = shapeOf(text.slice(start, end));
        if (term.careful && (form === "mixed" || (term.capitals && form === "capital"))) return;
        // A careful term in lower case is only taken where something is joined to it.
        const sure = !term.careful || form !== "lower" || loose;
        // A sample ID tied to this person: their name or initials joined to a number, as in
        // "PN-042" or "17_nair". A date beside a name stays a date.
        const after = /^([-_.]?)(\d+)(?!\d|[-/.]\d)[\p{L}\p{N}]*/u.exec(folded.slice(end));
        if (after?.[2] !== undefined && !looksLikeADate(after[2]) && (sure || after[1] !== "")) {
          found.push({ start, end: end + after[0].length, target: { kind: "sample" }, rank: 2 });
          return;
        }
        const before = /(?<![\p{L}\p{N}]|\d[-/.])(\d+)([-_.]?)$/u.exec(folded.slice(Math.max(0, start - 12), start));
        if (before?.[1] !== undefined && !looksLikeADate(before[1]) && (sure || before[2] !== "")) {
          found.push({ start: start - before[0].length, end, target: { kind: "sample" }, rank: 2 });
          return;
        }
        if (!sure && !joined(text, start, end)) return;
        // "P. Nair": the initial belongs to the name.
        const initial = /(?<!\p{L})(\p{L})[.']?\s*$/u.exec(folded.slice(Math.max(0, start - 4), start));
        const lead = initial?.[1] !== undefined && term.initials.includes(initial[1]) && isUpper(text[start - initial[0].length]) ? initial[0].length : 0;
        found.push({ start: start - lead, end, target: { kind: "person", key: term.key }, rank: 4 });
      });
    }
    // Earliest first, then the stronger kind, then the longer match; nothing overlaps.
    found.sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end);
    const kept: Span[] = [];
    for (const span of found) {
      const last = kept[kept.length - 1];
      // "ZOË MÜLLER" found as two words is still one mention of one person.
      if (last !== undefined && span.start >= last.end && span.target.kind === "person" && sameTarget(span.target, last.target) && /^[\s._,'-]*$/.test(text.slice(last.end, span.start))) last.end = span.end;
      else if (last === undefined || span.start >= last.end) kept.push(span);
      else if (span.end > last.end && span.target.kind === last.target.kind && sameTarget(span.target, last.target)) last.end = span.end;
      else if (span.end > last.end) kept.push({ ...span, start: last.end });
    }
    return kept;
  }

  function replacement(target: Target, matched: string): string {
    switch (target.kind) {
      case "person":
        return person(target.key);
      case "sample":
        return numbered(sampleOf, "Sample", fold(matched).replace(/[^\p{L}\p{N}]/gu, ""));
      case "email": {
        const owner = knownEmails.get(fold(matched));
        return owner === undefined ? numbered(emailOf, "Email", fold(matched)) : person(owner);
      }
      case "removed":
        return REMOVED;
      default: {
        const _exhaustive: never = target;
        return _exhaustive;
      }
    }
  }

  function scrub(input: string, loose: boolean): string {
    const text = input.normalize("NFC");
    let out = "";
    let at = 0;
    for (const span of spans(text, loose)) {
      out += text.slice(at, span.start) + replacement(span.target, text.slice(span.start, span.end));
      at = span.end;
      replacements += 1;
    }
    return out + text.slice(at);
  }

  return {
    text: (input) => scrub(input, false),
    fileName: (name) => {
      const dot = name.lastIndexOf(".");
      const hasExt = dot > 0 && /^\.[A-Za-z0-9]{1,10}$/.test(name.slice(dot));
      const stem = scrub(hasExt ? name.slice(0, dot) : name, true)
        .replaceAll(REMOVED, "removed")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .trim();
      return `${stem === "" || /^\.+$/.test(stem) ? "file" : stem}${hasExt ? name.slice(dot).toLowerCase() : ""}`;
    },
    person,
    isClean: (input) => spans(input.normalize("NFC"), false).length === 0,
    counts: () => ({ people: personOf.size, samples: sampleOf.size, emails: emailOf.size, replacements }),
  };
}

function shapeOf(word: string): "upper" | "capital" | "lower" | "mixed" {
  if (word === word.toUpperCase()) return "upper";
  if (word === word.toLowerCase()) return "lower";
  return word.slice(1) === word.slice(1).toLowerCase() ? "capital" : "mixed";
}

function sameTarget(a: Target, b: Target): boolean {
  return a.kind === "person" && b.kind === "person" ? a.key === b.key : a.kind === b.kind;
}
