import { describe, expect, it } from "vitest";
import { PersonId, UserId } from "../ids";
import { canClaim, peopleFailure, PeopleAccountsJson, unlinkedMembers, unlinkWarning, type PersonAccount } from "../people-accounts";

const ade = UserId.parse("00000000-0000-4000-8000-00000000000a");
const priya = UserId.parse("00000000-0000-4000-8000-00000000000b");
const jordan = UserId.parse("00000000-0000-4000-8000-00000000000c");
const person = (n: number, userId: UserId | null, you = false, yeses = 0): PersonAccount => ({
  id: PersonId.parse(`6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af00${n}`),
  name: ["Ade Okafor", "Priya Nair", "Jordan Morales"][n - 1] ?? "",
  aliases: [],
  userId,
  email: null,
  you,
  yeses,
});

describe("People linked to accounts", () => {
  it("reads lab_people's rows", () => {
    const [row] = PeopleAccountsJson.parse([
      { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af002", name: "Priya Nair", aliases: ["PN"], user_id: priya, email: "priya.n@university.edu", you: true, yeses: 2 },
    ]);
    expect(row).toEqual({ id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af002", name: "Priya Nair", aliases: ["PN"], userId: priya, email: "priya.n@university.edu", you: true, yeses: 2 });
  });

  it("offers This is me only on a row nobody has, to a viewer who isn't anyone yet", () => {
    const unlinked = [person(1, ade), person(2, priya), person(3, null)];
    expect(canClaim(unlinked[2]!, unlinked)).toBe(true);
    expect(canClaim(unlinked[1]!, unlinked)).toBe(false);
    const mine = [person(1, ade), person(2, priya, true), person(3, null)];
    expect(canClaim(mine[2]!, mine)).toBe(false);
  });

  it("lets an admin link a row only to members who aren't anyone yet", () => {
    const members = [{ userId: ade }, { userId: priya }, { userId: jordan }];
    expect(unlinkedMembers(members, [person(1, ade), person(2, null)])).toEqual([{ userId: priya }, { userId: jordan }]);
  });

  it("says before unlinking which yeses it takes back, and nothing when there are none", () => {
    expect(unlinkWarning(person(2, priya, false, 2), "Unlinking")).toBe(
      "Priya Nair said yes to 2 confirmed causes from this account. Unlinking takes those back, so those runs can't be shared outside the lab until Priya Nair says yes again from a linked account.",
    );
    expect(unlinkWarning(person(2, priya, false, 1), "Removing them")).toContain("said yes to 1 confirmed cause from this account. Removing them takes");
    expect(unlinkWarning(person(2, priya), "Unlinking")).toBeNull();
  });

  it("turns each linking error into its own plain answer", () => {
    expect(peopleFailure({ code: "BL982" }).status).toBe(409);
    expect(peopleFailure({ code: "BL983" }).message).toBe("That account is already linked to someone else in People. Unlink that first.");
    expect(peopleFailure({ code: "BL984" }).status).toBe(400);
    expect(peopleFailure({ code: "BL981" }).status).toBe(404);
    expect(peopleFailure({}).status).toBe(500);
  });
});
