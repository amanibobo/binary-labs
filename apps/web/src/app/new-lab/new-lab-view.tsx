import { CreateLabForm } from "./create-lab-form";

export function NewLabView({ email }: { email: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-16">
      <p className="text-[15px] font-semibold text-ink">Binary Labs</p>
      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-ink">Create your lab</h1>
      <p className="mt-2 mb-6 text-[15px] text-muted">
        You&apos;re signed in as <span className="text-ink">{email}</span>. If your lab already uses Binary Labs, ask an
        admin to invite this address instead.
      </p>
      <CreateLabForm />
    </main>
  );
}
