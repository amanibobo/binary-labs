import type { Metadata } from "next";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { link } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-4 py-16">
      <p className="text-[15px] font-semibold text-ink">Binary Labs</p>
      <h1 className="mt-8 text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
      <p className="mt-2 mb-6 text-[15px] text-muted">
        {link === "expired"
          ? "That link has expired or was already used. We'll send you a new one."
          : "We'll email you a link. No password needed."}
      </p>
      <SignInForm />
    </main>
  );
}
