"use client";

import { useActionState, useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { dataSurface } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDock } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { nameMatches } from "@/lib/lab-deletion";
import { deleteLab, type DeleteLabState } from "./actions";

export function DeleteLabSection({ labName }: { labName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn(dataSurface, "grid gap-3 p-5 sm:p-6")}>
      <p className="max-w-prose text-paragraph-medium text-content-secondary">
        Every member loses access at once, and there&apos;s no undo. Protocols, uploads, recordings and videos are kept
        only here, so save what you need first.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {/* A plain link: the route answers with a file to save. */}
        <a href="/api/protocols/export" download className={buttonVariants({ variant: "secondary" })}>
          Download protocols
        </a>
        <Dialog open={open} onOpenChange={setOpen}>
          <Button variant="tertiary" onClick={() => setOpen(true)}>
            Delete lab
          </Button>
          <DialogContent title={`Delete ${labName}?`} aria-describedby={undefined}>
            <DeleteLabForm labName={labName} onCancel={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>
    </div>
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
          Everything Binary Labs holds for {labName} is deleted: the index, labels, protocols, uploads, recordings and
          videos. Files in Dropbox stay as they are.
        </p>
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
        <Button type="submit" disabled={!ready || pending}>
          {pending ? "Deleting" : "Delete lab"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </DialogDock>
    </form>
  );
}
