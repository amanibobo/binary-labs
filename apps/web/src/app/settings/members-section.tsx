"use client";
import { useActionState, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { DataCell, DataHeaderCell, DataTable } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDock } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/field";
import { When } from "@/components/ui/when";
import type { LabMember } from "@/lib/domain";
import { changeMemberRole, inviteMember, removeMember, type InviteState } from "./actions";
import { SettingsGroup } from "./settings-frame";

export function MembersSection({ members, isAdmin, email }: { members: LabMember[]; isAdmin: boolean; email: string }) {
  const admins = members.filter((m) => m.role === "admin").length;
  return (
    <>
      <DataTable>
        <thead>
          <tr>
            <DataHeaderCell>Email</DataHeaderCell>
            <DataHeaderCell className="w-28 sm:w-32">Role</DataHeaderCell>
            <DataHeaderCell className="hidden w-36 sm:table-cell">Joined</DataHeaderCell>
            {isAdmin ? (
              <DataHeaderCell className="w-12 sm:w-28">
                <span className="sr-only">Remove</span>
              </DataHeaderCell>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const you = member.email === email;
            // The lab keeps an admin, so the last one can't step down or leave.
            const lastAdmin = member.role === "admin" && admins === 1;
            const manageable = isAdmin && !lastAdmin;
            return (
              <tr key={member.userId} className="border-t border-border-opaque">
                <DataCell>
                  <span className="flex min-w-0 items-center gap-3">
                    <Avatar label={member.email ?? "?"} tintKey={member.email ?? member.userId} />
                    <span className="min-w-0 truncate text-paragraph-medium text-content-primary">{member.email ?? "Unknown address"}</span>
                    {you ? <span className="shrink-0 text-paragraph-small text-content-tertiary">You</span> : null}
                  </span>
                </DataCell>
                <DataCell className="text-paragraph-medium text-content-secondary">
                  {manageable ? <RolePicker member={member} you={you} /> : roleName(member.role)}
                </DataCell>
                <DataCell className="hidden text-paragraph-small text-content-tertiary sm:table-cell">
                  <When iso={member.joinedAt} />
                </DataCell>
                {isAdmin ? <DataCell className="text-right">{manageable ? <RemoveMember member={member} you={you} /> : null}</DataCell> : null}
              </tr>
            );
          })}
        </tbody>
      </DataTable>
      {isAdmin && admins === 1 ? (
        <p className="-mt-6 text-paragraph-small text-content-tertiary">A lab needs at least one admin. Make someone else an admin before you step down or leave.</p>
      ) : null}
      {isAdmin ? (
        <SettingsGroup>
          <InviteForm className="px-5 py-4 sm:px-6" />
        </SettingsGroup>
      ) : null}
    </>
  );
}

const roleName = (role: LabMember["role"]) => (role === "admin" ? "Admin" : "Member");

function RolePicker({ member, you }: { member: LabMember; you: boolean }) {
  const [pending, start] = useTransition();
  return (
    <select
      aria-label={`Role for ${member.email ?? "this member"}`}
      value={member.role}
      disabled={pending}
      onChange={(e) => {
        const role = e.target.value;
        start(async () => {
          const result = await changeMemberRole(member.userId, role);
          if (result.kind === "error") toast.error(result.message);
          else toast(you ? "You're a member now. Settings for the lab are an admin's." : `${member.email ?? "They"} ${role === "admin" ? "is an admin now" : "is a member now"}.`);
        });
      }}
      className="min-h-11 rounded-control border border-border-opaque bg-background-secondary px-2 text-paragraph-small text-content-primary sm:min-h-8"
    >
      <option value="admin">Admin</option>
      <option value="member">Member</option>
    </select>
  );
}

function RemoveMember({ member, you }: { member: LabMember; you: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const who = member.email ?? "this member";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="tertiary" size="compact" onClick={() => setOpen(true)}>
        {you ? "Leave" : "Remove"}
      </Button>
      <DialogContent title={you ? "Leave this lab?" : `Remove ${who}?`} aria-describedby={undefined}>
        <div className="grid gap-3 px-4 pt-3 text-paragraph-medium text-content-secondary sm:px-6">
          <p>{you ? "You lose access to the lab at once." : "They lose access to the lab at once."} An admin can invite {you ? "you" : "them"} again later.</p>
          <p>
            Nothing {you ? "you" : "they"} made is deleted. Uploads, recordings, protocol versions, label fixes, notes and answers stay in the
            lab under {you ? "your" : "their"} name.
          </p>
        </div>
        <DialogDock className="pt-5">
          <Button
            variant="negative"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await removeMember(member.userId);
                if (result.kind === "error") toast.error(result.message);
                else {
                  setOpen(false);
                  toast(`Removed ${who}.`);
                }
              })
            }
          >
            {pending ? "Removing" : you ? "Leave lab" : "Remove"}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogDock>
      </DialogContent>
    </Dialog>
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
