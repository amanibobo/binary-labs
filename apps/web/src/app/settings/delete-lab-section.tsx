"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDock } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/field";
import { nameMatches } from "@/lib/lab-deletion";
import { deleteLab, type DeleteLabState } from "./actions";
import { SettingsGroup, SettingsRow } from "./settings-frame";

// Admins only. It sits apart at the foot of General, and the dialog asks for the lab's name.
export function DeleteLabRow({ labName }: { labName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsGroup>
      <SettingsRow
        label="Delete this lab"
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <Button variant="negative" onClick={() => setOpen(true)}>
              Delete lab
            </Button>
            <DialogContent title={`Delete ${labName}?`} aria-describedby={undefined}>
              <DeleteLabForm labName={labName} onCancel={() => setOpen(false)} />
            </DialogContent>
          </Dialog>
        }
      >
        Every member loses access at once, and there&apos;s no undo. Files in Dropbox stay as they are.
      </SettingsRow>
    </SettingsGroup>
  );
}

function DeleteLabForm({ labName, onCancel }: { labName: string; onCancel: () => void }) {
  const [state, action, pending] = useActionState<DeleteLabState, FormData>(deleteLab, { kind: "idle" });
  const [typed, setTyped] = useState(state.kind === "idle" ? "" : state.typed);
  const id = useId();
  const ready = nameMatches({ typed, labName });
  return (
    <form action={action}>
      <div className="grid gap-3 px-4 pt-3 text-paragraph-medium text-content-secondary sm:px-6">
        <p>
          Everything Binary holds for {labName} is deleted: the index, labels, protocols, uploads, recordings and
          videos. Files in Dropbox stay as they are.
        </p>
        <p>Protocols, uploads, recordings and videos are kept only here, so download what you need first.</p>
      </div>
      <div className="grid gap-1.5 px-4 pt-5 sm:px-6">
        <Label htmlFor={`${id}-name`}>
          Type <span className="font-semibold">{labName}</span> to confirm
        </Label>
        <Input
          id={`${id}-name`}
          name="name"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-invalid={state.kind === "wrong_name"}
          aria-describedby={`${id}-status`}
        />
        <p id={`${id}-status`} role="status" className="min-h-6 text-paragraph-small text-content-tertiary">
          {state.kind === "wrong_name"
            ? "That isn't the lab's name. Type it exactly as shown."
            : state.kind === "error"
              ? state.message
              : null}
        </p>
      </div>
      <DialogDock className="pt-2">
        <Button type="submit" variant="negative" disabled={!ready || pending}>
          {pending ? "Deleting" : "Delete lab"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </DialogDock>
    </form>
  );
}
