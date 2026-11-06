"use client";
import { useActionState, useId } from "react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { DataCell, DataHeaderCell, DataTable } from "@/components/ui/data-table";
import { Input, Label } from "@/components/ui/field";
import { When } from "@/components/ui/when";
import type { LabMember } from "@/lib/domain";
import { inviteMember, type InviteState } from "./actions";
import { SettingsGroup } from "./settings-frame";

export function MembersSection({ members, isAdmin, email }: { members: LabMember[]; isAdmin: boolean; email: string }) {
  return (
    <>
      <DataTable>
        <thead>
          <tr>
            <DataHeaderCell>Email</DataHeaderCell>
            <DataHeaderCell className="w-24 sm:w-32">Role</DataHeaderCell>
            <DataHeaderCell className="hidden w-36 sm:table-cell">Joined</DataHeaderCell>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId} className="border-t border-border-opaque">
              <DataCell>
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar label={member.email ?? "?"} tintKey={member.email ?? member.userId} />
                  <span className="min-w-0 truncate text-paragraph-medium text-content-primary">{member.email ?? "Unknown address"}</span>
                  {member.email === email ? <span className="shrink-0 text-paragraph-small text-content-tertiary">You</span> : null}
                </span>
              </DataCell>
              <DataCell className="text-paragraph-medium text-content-secondary">{member.role === "admin" ? "Admin" : "Member"}</DataCell>
              <DataCell className="hidden text-paragraph-small text-content-tertiary sm:table-cell">
                <When iso={member.joinedAt} />
              </DataCell>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {isAdmin ? (
        <SettingsGroup>
          <InviteForm className="px-5 py-4 sm:px-6" />
        </SettingsGroup>
      ) : null}
    </>
  );
}

export function InviteForm({ className }: { className?: string }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(inviteMember, { kind: "idle" });
  const id = useId();
  const error = state.kind === "error" ? state : null;
  return (
    <form action={action} className={cn("grid gap-2", className)}>
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
