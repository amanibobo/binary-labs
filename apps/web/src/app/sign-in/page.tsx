import type { Metadata } from "next";
import { CenteredCard } from "@/components/centered-card";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { link } = await searchParams;
  return (
    <CenteredCard
      title="Sign in"
      description={
        link === "expired"
          ? "That link has expired or was already used. We'll send you a new one."
          : "We'll email you a link. No password needed."
      }
    >
      <SignInForm />
    </CenteredCard>
  );
}
