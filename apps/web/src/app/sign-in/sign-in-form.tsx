"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { sendMagicLink, type SignInState } from "./actions";

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(sendMagicLink, { kind: "idle" });
  const id = useId();

  if (state.kind === "sent") {
    return (
      <div role="status" className="rounded-xl border border-border-opaque bg-background-secondary p-4">
        <h2 className="text-label-medium">Check your email</h2>
        <p className="mt-1 text-paragraph-medium text-content-tertiary">
          We sent a sign-in link to <span className="text-content-primary">{state.email}</span>. Open it on this device to sign in.
        </p>
      </div>
    );
  }

  const error = state.kind === "error" ? state : null;
  return (
    <form action={action} className="grid gap-4" noValidate>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="name@lab.edu"
          defaultValue={error?.email ?? ""}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `${id}-error`}
          required
        />
        {error === null ? null : (
          <p id={`${id}-error`} className="text-paragraph-small text-content-primary">
            {error.message}
          </p>
        )}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Sending link" : "Email me a sign-in link"}
      </Button>
    </form>
  );
}
