import type { ReactNode } from "react";
import { Dish } from "./dish";

const PILOT_MAILTO = "mailto:hello@binarylabs.example?subject=Pilot%20request";
const CALL_MAILTO = "mailto:hello@binarylabs.example?subject=Book%20a%20call";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const STEPS: readonly { title: string; body: ReactNode }[] = [
  {
    title: "Connect one folder.",
    body: "Binary Labs asks Dropbox for read-only access to a single folder and nothing else. Your files stay where they are, under the names you gave them.",
  },
  {
    title: "It reads what is inside.",
    body: "PDFs, spreadsheets, Word documents, plate reader exports and notes are read for their text, tables and headers. Photos are indexed by when they were taken and where they were saved.",
  },
  {
    title: "Ask the way you would ask a labmate.",
    body: (
      <>
        &ldquo;P450 gels from batch 3&rdquo; finds the files by meaning and by name, even when the
        name is <Mono>final_v2_REAL.xlsx</Mono>. Every result shows a preview, the original file
        and the folder it lives in.
      </>
    ),
  },
  {
    title: "Copies count once.",
    body: "The same file saved in four folders shows up as one result, with every place it lives.",
  },
];

function Mono({ children }: { children: string }) {
  return <span className="font-mono text-[0.86em] tracking-normal">{children}</span>;
}

function TextLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      className="underline decoration-1 underline-offset-[0.2em] hover:decoration-2 focus-visible:decoration-2"
    >
      {children}
    </a>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-[1.9em]">
      <h2 className="text-neutral-500">{title}</h2>
      <div className="mt-[0.6em]">{children}</div>
    </section>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 pt-5 text-[15px] sm:px-8 sm:pt-7">
        <p className="font-medium">Binary Labs</p>
        <a href={APP_URL} className="underline-offset-4 hover:underline focus-visible:underline">
          Sign in
        </a>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pt-[12vh] text-[20px] leading-[1.3] tracking-[-0.012em] sm:text-[22px]">
        <p>
          Every lab has run the experiment before. The data is somewhere in a Dropbox folder, named{" "}
          <Mono>IMG_4821.jpg</Mono>, saved by someone who graduated two years ago.
        </p>
        <p className="mt-[1.3em]">
          Binary Labs remembers everything your lab has done. It reads the files you already have,
          finds any of them by what is in them, and never moves a thing.
        </p>
        <p className="mt-[1.3em]">
          <TextLink href={PILOT_MAILTO}>Request a pilot</TextLink>
        </p>
      </main>

      <figure className="float mx-auto mt-[12vh] w-[min(380px,82vw)]">
        <Dish />
      </figure>

      <div className="mx-auto w-full max-w-[640px] px-4 pt-[10vh] pb-24 text-[20px] leading-[1.3] tracking-[-0.012em] sm:text-[22px]">
        <Section title="How it works">
          <ol className="space-y-[1em]">
            {STEPS.map((step) => (
              <li key={step.title}>
                <span className="font-medium">{step.title}</span> {step.body}
              </li>
            ))}
          </ol>
        </Section>

        <Section title="What it will not do">
          <p>
            It never writes to your Dropbox, moves a file or renames one. Your lab&rsquo;s files are
            never used to train models, and lab text is searched with a model we run ourselves. One
            request deletes everything we hold about your lab.
          </p>
        </Section>

        <Section title="What comes next">
          <p>
            Capture and teaching. Photos of gels and notebook pages from the bench, protocol pages a
            new student can follow, and the walkthrough videos your last postdoc recorded, linked to
            the steps they show.
          </p>
        </Section>

        <Section title="The pilot">
          <p>
            We are starting with a few academic wet labs this winter. A pilot is free for a month
            and needs about twenty minutes of the PI&rsquo;s time to set up.
          </p>
          <p className="mt-[1.3em]">
            <TextLink href={PILOT_MAILTO}>Request a pilot</TextLink>
            <span className="text-neutral-500"> or </span>
            <TextLink href={CALL_MAILTO}>book a call</TextLink>
          </p>
        </Section>
      </div>

      <footer className="mt-auto flex items-center justify-between px-4 pb-6 text-[14px] text-neutral-500 sm:px-8">
        <p>Binary Labs</p>
        <p>2026</p>
      </footer>
    </div>
  );
}
