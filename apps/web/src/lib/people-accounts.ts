import { z } from "zod";
import { PersonId, UserId } from "./ids";
import { fromRow, type RunFailure } from "./run-record";

// People linked to accounts (decisions.md, "People linked to accounts"): which member's
// account is each of the lab's People, so a named confirmer can say yes from their own.

// One of the lab's People as lab_people (0042) reads it. `yeses` is how many confirmed causes
// this person has said yes to, which unlinking would take back.
export const PersonAccount = z.object({
  id: PersonId,
  name: z.string(),
  aliases: z.array(z.string()),
  userId: UserId.nullable(),
  email: z.string().nullable(),
  you: z.boolean(),
  yeses: z.number().int().nonnegative(),
});
export type PersonAccount = z.infer<typeof PersonAccount>;
export const PeopleAccountsJson = fromRow(z.array(PersonAccount));

// "This is me" is offered on a row nobody has, to a viewer who isn't anyone yet.
export function canClaim(person: PersonAccount, people: readonly PersonAccount[]): boolean {
  return person.userId === null && !people.some((p) => p.you);
}

// The members an admin can link a row to: those who aren't someone in People yet.
export function unlinkedMembers<M extends { userId: string }>(members: readonly M[], people: readonly PersonAccount[]): M[] {
  const linked = new Set(people.flatMap((p) => (p.userId === null ? [] : [p.userId])));
  return members.filter((m) => !linked.has(m.userId));
}

// What unlinking says before it happens, when the person has said yes to anything.
export function unlinkWarning(person: Pick<PersonAccount, "name" | "yeses">): string | null {
  if (person.yeses === 0) return null;
  const causes = person.yeses === 1 ? "1 confirmed cause" : `${person.yeses} confirmed causes`;
  return `${person.name} said yes to ${causes} from this account. Unlinking takes those back, so those runs can't be shared outside the lab until ${person.name} says yes again from a linked account.`;
}

const FAILURES: Readonly<Record<string, RunFailure>> = {
  "42501": { status: 403, message: "Only an admin can link or unlink someone else." },
  BL981: { status: 404, message: "That person isn't in the lab's People any more." },
  BL982: { status: 409, message: "That person is already linked to another account. An admin can unlink them in Settings, People." },
  BL983: { status: 409, message: "That account is already linked to someone else in People. Unlink that first." },
  BL984: { status: 400, message: "That account isn't a member of this lab." },
};
export function peopleFailure(error: { code?: string }): RunFailure {
  return FAILURES[error.code ?? ""] ?? { status: 500, message: "We couldn't save that. Try again." };
}
