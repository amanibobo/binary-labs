import { CenteredCard } from "@/components/centered-card";
import { CreateLabForm } from "./create-lab-form";

export function NewLabView({ email }: { email: string }) {
  return (
    <CenteredCard
      title="Create your lab"
      description={
        <>
          You&apos;re signed in as <span className="text-content-primary">{email}</span>. If your lab already uses Binary Labs, ask an
          admin to invite this address instead.
        </>
      }
    >
      <CreateLabForm />
    </CenteredCard>
  );
}
