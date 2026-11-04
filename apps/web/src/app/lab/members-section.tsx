"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import type { LabMember } from "@/lib/domain";
import { formatDate } from "@/lib/format";
import { inviteMember, type InviteState } from "./actions";

export function MembersSection({ members, isAdmin }: { members: LabMember[]; isAdmin: boolean }) {
  return (
    <div>
      <ul className="divide-y divide-border-opaque rounded-lg border border-border-opaque bg-background-primary">
        {members.map((member) => (
          <li key={member.userId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-3">
            <span className="min-w-0 truncate text-paragraph-medium text-content-primary">{member.email ?? "Unknown address"}</span>
            <span className="text-paragraph-small text-content-tertiary">
              {member.role === "admin" ? "Admin" : "Member"} since {formatDate(member.joinedAt)}
            </span>
          </li>
        ))}
      </ul>
      {isAdmin ? <InviteForm /> : null}
    </div>
  );
}

function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(inviteMember, { kind: "idle" });
  const id = useId();
  const error = state.kind === "error" ? state : null;
  return (
    <form action={action} className="mt-6 grid gap-1.5">
      <Label htmlFor={`${id}-email`}>Invite by email</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="name@lab.edu"
          key={state.kind === "invited" ? state.email : "draft"}
          defaultValue={error?.email ?? ""}
          aria-invalid={error !== null}
          aria-describedby={`${id}-status`}
          required
        />
        <Button type="submit" variant="secondary" disabled={pending} className="sm:w-auto">
          {pending ? "Sending invite" : "Send invite"}
        </Button>
      </div>
      <p id={`${id}-status`} role="status" className="min-h-6 text-paragraph-small text-content-tertiary">
        {state.kind === "invited"
          ? state.existingAccount
            ? `${state.email} already has an account and can see the lab the next time they sign in.`
            : `Invite sent to ${state.email}.`
          : state.kind === "error"
            ? state.message
            : "Invited people join as members. They can search but not change settings."}
      </p>
    </form>
  );
}
