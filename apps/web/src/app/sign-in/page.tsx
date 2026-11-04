import type { Metadata } from "next";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { link } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col px-4 pt-16 pb-16 sm:justify-center">
      <p className="text-heading-xsmall">Binary Labs</p>
      <h1 className="mt-8 text-heading-large">Sign in</h1>
      <p className="mt-2 mb-6 text-paragraph-medium text-content-tertiary">
        {link === "expired"
          ? "That link has expired or was already used. We'll send you a new one."
          : "We'll email you a link. No password needed."}
      </p>
      <SignInForm />
    </main>
  );
}
