import type { ReactNode } from "react";
import { Highlights } from "./highlights";
import { APP_URL, CALL_MAILTO, PILOT_MAILTO } from "./links";
import { LogoMark } from "./logo";
import { SocialLinks } from "./social";

function Mark({ tone, children }: { tone: "green" | "blue"; children: ReactNode }) {
  return <mark className={`hl hl-${tone}`}>{children}</mark>;
}

function Ink({ tone, children }: { tone: "green" | "blue"; children: ReactNode }) {
  return <span className={tone === "green" ? "text-brand-green" : "text-brand-blue"}>{children}</span>;
}

function Mono({ children }: { children: string }) {
  return <span className="font-mono text-[0.88em]">{children}</span>;
}

function Link({ href, children, tone }: { href: string; children: string; tone?: "green" }) {
  return (
    <a
      href={href}
      className={`inline-flex min-h-11 items-center underline decoration-1 underline-offset-[0.25em] transition-colors hover:decoration-2 ${
        tone === "green" ? "text-brand-green decoration-brand-green/50" : "decoration-black/25 hover:text-black"
      }`}
    >
      {children}
    </a>
  );
}

export default function Home() {
  const links = [
    PILOT_MAILTO === null ? null : (
      <Link key="pilot" href={PILOT_MAILTO} tone="green">
        Request a pilot
      </Link>
    ),
    APP_URL === null ? null : (
      <Link key="app" href={APP_URL}>
        Sign in
      </Link>
    ),
    CALL_MAILTO === null ? null : (
      <Link key="call" href={CALL_MAILTO}>
        Book a call
      </Link>
    ),
  ]
    .filter((link) => link !== null)
    .flatMap((link, i) => (i === 0 ? [link] : [<span key={`dot-${i}`} aria-hidden>&middot;</span>, link]));
  return (
    <div className="flex min-h-dvh flex-col px-5">
      <main className="mx-auto w-full max-w-[460px] flex-1 pt-20 pb-16 sm:pt-28">
        <h1 className="flex items-center gap-3 font-serif text-[32px] leading-[1.1] tracking-[-0.01em] sm:text-[36px]">
          <LogoMark className="h-[0.8em] w-auto shrink-0" />
          Binary
        </h1>
        <p className="mt-4 text-[15px] leading-[1.6] text-black/70">
          One private place for everything your research lab produces. It finds any file in seconds and teaches new people from the
          lab&rsquo;s own work.
        </p>

        {links.length === 0 ? null : (
          <nav aria-label="Links" className="mt-3 flex flex-wrap items-center gap-x-2.5 text-[13px] text-black/55">
            {links}
          </nav>
        )}

        <section aria-labelledby="mission" className="mt-16 sm:mt-20">
          <h2 id="mission" className="font-mono text-[11px] text-black/40">
            our mission
          </h2>
          <Highlights className="mt-6 space-y-5 text-[15px] leading-[1.7] text-black/80">
            <p>
              A lab&rsquo;s best work is already done. It sits in a shared folder as <Mono>IMG_4821.jpg</Mono>,{" "}
              <Mono>final_v2_REAL.xlsx</Mono> and a protocol only one postdoc remembers how to run.
            </p>
            <p>
              Every year people leave and <Mark tone="blue">take the know-how with them</Mark>. The new student starts from zero, and
              the seniors spend their afternoons teaching the same steps again.
            </p>
            <p>
              We think a lab should <Mark tone="green">remember everything it has done</Mark>. Ask for &ldquo;P450 gels from batch
              3&rdquo; and get the gel, the file it came from and the folder it lives in, <Ink tone="blue">in seconds</Ink>.
            </p>
            <p>
              So we <Ink tone="green">read and never write</Ink>. Binary gets read-only access to one folder and moves nothing.
              Your files are <Mark tone="green">never used to train models</Mark>, and one request deletes everything we hold.
            </p>
            <p>
              We start small. Finding things first, then capture and teaching at the bench, then the instruments.{" "}
              <Mark tone="blue">Each step ships only after a real lab uses the last one.</Mark>
            </p>
          </Highlights>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-[460px] items-center justify-between border-t border-black/[0.07] py-2 text-[12px] text-black/40">
        <span>Binary, {new Date().getFullYear()}</span>
        <SocialLinks />
      </footer>
    </div>
  );
}
