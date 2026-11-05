import type { ReactNode } from "react";
import { Features } from "./features";
import { Hero } from "./hero";
import { Letter } from "./letter";
import { CALL_MAILTO, PILOT_MAILTO } from "./links";
import { Mark } from "./mark";
import { Menubar } from "./menubar";
import { Reveal } from "./motion";

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
        &ldquo;P450 gels from batch 3&rdquo; finds the files by meaning and by name, even when the name is <Mono>final_v2_REAL.xlsx</Mono>.
        Every result shows a preview, the original file and the folder it lives in.
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
    <a href={href} className="inline-flex min-h-11 items-center underline decoration-1 underline-offset-[0.2em] hover:decoration-2 focus-visible:decoration-2">
      {children}
    </a>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="disclosure group border-t-2 border-dotted border-black/15 last:border-b-2">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-4 py-[0.7em] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black [&::-webkit-details-marker]:hidden">
        <h2 className="font-medium">{title}</h2>
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-5 shrink-0 text-black/45 transition-transform duration-200 ease-out group-open:rotate-45 motion-reduce:transition-none"
        >
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
        </svg>
      </summary>
      <div className="pb-[1.1em] text-black/70">{children}</div>
    </details>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip">
      <Menubar />
      <main>
        <Hero />
        <Features />
        <Letter />

        <section id="details" aria-label="Details" className="scroll-mt-16 px-5 pt-16 pb-24 lg:pt-24">
          <Reveal className="mx-auto w-full max-w-[640px] text-[20px] leading-[1.3] tracking-[-0.6px] sm:text-[22px]">
            <Section title="How it works">
              <ol className="space-y-[1em]">
                {STEPS.map((step) => (
                  <li key={step.title}>
                    <span className="font-medium text-black">{step.title}</span> {step.body}
                  </li>
                ))}
              </ol>
            </Section>

            <Section title="What it will not do">
              <p>
                It never writes to your Dropbox, moves a file or renames one. Your lab&rsquo;s files are never used to train models, and lab
                text is searched with a model we run ourselves. One request deletes everything we hold about your lab.
              </p>
            </Section>

            <Section title="What comes next">
              <p>
                Capture and teaching. Photos of gels and notebook pages from the bench, protocol pages a new student can follow, and the
                walkthrough videos your last postdoc recorded, linked to the steps they show.
              </p>
            </Section>

            <Section title="The pilot">
              <p>
                We are starting with a few academic wet labs this winter. A pilot is free for a month and needs about twenty minutes of the
                PI&rsquo;s time to set up.
              </p>
              <p className="mt-[1.3em]">
                <TextLink href={PILOT_MAILTO}>Request a pilot</TextLink>
                <span className="text-black/45"> or </span>
                <TextLink href={CALL_MAILTO}>book a call</TextLink>
              </p>
            </Section>
          </Reveal>
        </section>
      </main>

      <footer className="mt-auto flex items-center justify-between border-t border-black/5 px-5 py-6 text-[14px] text-black/45 lg:px-6">
        <p className="flex items-center gap-2">
          <Mark animated={false} className="size-4 text-black/70" />
          Binary Labs
        </p>
        <p>2026</p>
      </footer>
    </div>
  );
}
