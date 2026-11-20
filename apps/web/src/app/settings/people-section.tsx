"use client";

import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDock } from "@/components/ui/dialog";
import { Label } from "@/components/ui/field";
import type { LabMember } from "@/lib/domain";
import { canClaim, unlinkedMembers, unlinkWarning, type PersonAccount } from "@/lib/people-accounts";
import { claimPerson, linkPerson, unlinkPerson } from "./actions";
import { LabListSection } from "./lab-list-section";

// Settings, People: the lab's list, and the account each person is linked to. A linked person
// can say yes to a cause they're named as confirming. Anyone who isn't someone here yet can
// choose "This is me"; an admin links and unlinks anyone.
export function PeopleSection({ people, members, isAdmin }: { people: PersonAccount[]; members: LabMember[]; isAdmin: boolean }) {
  const free = unlinkedMembers(members, people);
  const entries = people.map((person) => ({
    id: person.id,
    name: person.name,
    aliases: person.aliases,
    detail: person.email === null ? undefined : person.you ? `You, signed in as ${person.email}` : `Signs in as ${person.email}`,
    actions: (
      <>
        {canClaim(person, people) ? <ClaimButton person={person} /> : null}
        {isAdmin && person.userId === null && free.length > 0 ? <LinkDialog person={person} members={free} /> : null}
        {isAdmin && person.userId !== null ? <UnlinkDialog person={person} /> : null}
      </>
    ),
  }));
  return <LabListSection kind="people" entries={entries} isAdmin={isAdmin} />;
}

function ClaimButton({ person }: { person: PersonAccount }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="secondary"
      size="compact"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await claimPerson(person.id);
          if (result.kind === "error") toast.error(result.message);
          else toast(`You're linked to ${person.name}.`);
        })
      }
    >
      This is me<span className="sr-only">: {person.name}</span>
    </Button>
  );
}

function LinkDialog({ person, members }: { person: PersonAccount; members: LabMember[] }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string>(members[0]?.userId ?? "");
  const [pending, start] = useTransition();
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="tertiary" size="compact" onClick={() => setOpen(true)}>
        Link<span className="sr-only"> {person.name} to an account</span>
      </Button>
      <DialogContent title={`Link ${person.name} to an account`} aria-describedby={undefined}>
        <div className="grid gap-2 px-4 pt-3 sm:px-6">
          <p className="text-paragraph-medium text-content-secondary">Then they can say yes, from their own account, to a cause they&rsquo;re named as confirming.</p>
          <Label htmlFor={id}>Which member is {person.name}?</Label>
          <select
            id={id}
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            className="min-h-11 rounded-control border border-border-opaque bg-background-secondary px-2 text-paragraph-medium text-content-primary sm:min-h-9"
          >
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.email ?? "Unknown address"}
              </option>
            ))}
          </select>
        </div>
        <DialogDock className="pt-5">
          <Button
            disabled={pending || picked === ""}
            onClick={() =>
              start(async () => {
                const result = await linkPerson(person.id, picked);
                if (result.kind === "error") toast.error(result.message);
                else {
                  setOpen(false);
                  toast(`${person.name} is linked.`);
                }
              })
            }
          >
            {pending ? "Linking" : "Link"}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogDock>
      </DialogContent>
    </Dialog>
  );
}

function UnlinkDialog({ person }: { person: PersonAccount }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const warning = unlinkWarning(person, "Unlinking");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="tertiary" size="compact" onClick={() => setOpen(true)}>
        Unlink<span className="sr-only"> {person.name}</span>
      </Button>
      <DialogContent title={`Unlink ${person.name}?`} aria-describedby={undefined}>
        <div className="grid gap-3 px-4 pt-3 text-paragraph-medium text-content-secondary sm:px-6">
          <p>
            {person.email ?? "Their account"} stays in the lab, but can&rsquo;t say yes as {person.name} any more. Files and runs that name {person.name} keep
            the name.
          </p>
          {warning === null ? null : <p className="text-content-primary">{warning}</p>}
        </div>
        <DialogDock className="pt-5">
          <Button
            variant="negative"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await unlinkPerson(person.id);
                if (result.kind === "error") toast.error(result.message);
                else {
                  setOpen(false);
                  toast(`${person.name} is unlinked.`);
                }
              })
            }
          >
            {pending ? "Unlinking" : "Unlink"}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogDock>
      </DialogContent>
    </Dialog>
  );
}
