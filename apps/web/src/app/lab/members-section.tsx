"use client";

import { useActionState, useId } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { dataRow, dataSurface } from "@/components/ui/data-table";
import { Input, Label } from "@/components/ui/field";
import type { LabMember } from "@/lib/domain";
import { formatDate } from "@/lib/format";
import { inviteMember, type InviteState } from "./actions";

export function MembersSection({ members, isAdmin }: { members: LabMember[]; isAdmin: boolean }) {
  return (
    <div className={dataSurface}>
      <ul>
        {members.map((member) => (
          <li key={member.userId} className={`${dataRow} flex min-h-14 items-center gap-3 px-5 py-3 sm:px-6`}>
            <Avatar label={member.email ?? "?"} tintKey={member.email ?? member.userId} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-paragraph-medium text-content-primary">{member.email ?? "Unknown address"}</span>
              <span className="block text-paragraph-small text-content-tertiary">Joined {formatDate(member.joinedAt)}</span>
            </span>
            <span className="shrink-0 text-label-small text-content-secondary">{member.role === "admin" ? "Admin" : "Member"}</span>
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
    <form action={action} className="grid gap-2 border-t border-border-opaque px-5 pt-4 pb-4 sm:px-6">
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
      <p id={`${id}-status`} role="status" className="text-paragraph-small text-content-tertiary">
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
