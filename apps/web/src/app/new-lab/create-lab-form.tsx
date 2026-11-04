"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { createLab, type CreateLabState } from "./actions";

export function CreateLabForm() {
  const [state, action, pending] = useActionState<CreateLabState, FormData>(createLab, { kind: "idle" });
  const id = useId();
  const error = state.kind === "error" ? state : null;
  return (
    <form action={action} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>Lab name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          placeholder="Okafor Lab, Protein Biophysics"
          autoComplete="organization"
          maxLength={120}
          defaultValue={error?.name ?? ""}
          aria-invalid={error !== null}
          aria-describedby={error === null ? `${id}-hint` : `${id}-error`}
          required
        />
        {error === null ? (
          <p id={`${id}-hint`} className="text-sm text-muted">
            Members see this name. You can invite them next.
          </p>
        ) : (
          <p id={`${id}-error`} className="text-sm text-ink">
            {error.message}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating lab" : "Create lab"}
      </Button>
    </form>
  );
}
