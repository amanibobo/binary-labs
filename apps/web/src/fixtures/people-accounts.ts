import type { PersonAccount } from "@/lib/people-accounts";
import { members, people } from "./data";

// The fixture lab's People with their accounts: Ade and Priya are linked, and Priya has said yes
// to two confirmed causes; Jordan Morales isn't linked yet. `viewerEmail` is whose page it is.
const LINKS = [
  { member: 0, yeses: 0 },
  { member: 1, yeses: 2 },
  { member: null, yeses: 0 },
] as const;

export function fixturePeopleAccounts(viewerEmail: string): PersonAccount[] {
  return people.map((p, i) => {
    const link = LINKS[i] ?? { member: null, yeses: 0 };
    const member = link.member === null ? undefined : members[link.member];
    return {
      id: p.id,
      name: p.name,
      aliases: p.aliases,
      userId: member?.userId ?? null,
      email: member?.email ?? null,
      you: member !== undefined && member.email === viewerEmail,
      yeses: link.yeses,
    };
  });
}
