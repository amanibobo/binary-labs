import { CreateLabForm } from "./create-lab-form";

export function NewLabView({ email }: { email: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-16 pb-16 sm:justify-center">
      <p className="text-heading-xsmall">Binary Labs</p>
      <h1 className="mt-8 text-heading-large">Create your lab</h1>
      <p className="mt-2 mb-6 text-paragraph-medium text-content-tertiary">
        You&apos;re signed in as <span className="text-content-primary">{email}</span>. If your lab already uses Binary Labs, ask an
        admin to invite this address instead.
      </p>
      <CreateLabForm />
    </main>
  );
}
