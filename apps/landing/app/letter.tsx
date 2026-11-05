import type { CSSProperties, ReactNode } from "react";
import { Dish } from "./dish";
import { Mark } from "./mark";
import { Reveal } from "./motion";

function Ink({ children, delay }: { children: ReactNode; delay: number }) {
  return (
    <span className="ink" style={{ "--ink-delay": `${delay}s` } as CSSProperties}>
      {children}
    </span>
  );
}

// Why we are building this, written as a note on the same desktop.
export function Letter() {
  return (
    <section id="why" aria-label="Why" className="relative scroll-mt-16 px-5 pt-24 pb-8 lg:pt-40">
      <figure aria-hidden className="float pointer-events-none absolute top-[38%] right-[calc(50%+300px)] hidden w-[260px] lg:block">
        <Dish />
      </figure>
      <Reveal className="mx-auto w-full max-w-[480px]">
        <p className="mx-auto mb-4 w-fit rounded-full border border-black/15 bg-white px-2.5 py-0.5 text-[12px] text-black/50">Why</p>
        <div className="win w-full">
          <div className="win-bar">
            <span className="lights" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="win-title">notes.txt</span>
          </div>
          <div className="win-screen bg-white px-5 pt-5 pb-4 text-[16px] leading-[1.6] tracking-[-0.3px] text-black/75 lg:px-6">
            <p>
              Every lab has <Ink delay={0.3}>run the experiment before</Ink>. The data is somewhere in a Dropbox folder, named{" "}
              <span className="font-mono text-[0.88em]">IMG_4821.jpg</span>, saved by someone who graduated two years ago.
            </p>
            <p className="mt-3">
              We asked PhD students whether their lab repeats experiments because earlier data could not be found or trusted.{" "}
              <Ink delay={0.7}>&ldquo;Absolutely, it does. It does quite a lot.&rdquo;</Ink>
            </p>
            <p className="mt-3">
              Binary Labs remembers everything your lab has done. It reads the files you already have, finds any of them by what is
              in them, and <Ink delay={1.1}>never moves a thing</Ink>.
            </p>
            <p className="caret mt-3">We are starting with a few academic wet labs this winter.</p>
            <div className="mt-6 flex items-center justify-between border-t border-black/10 pt-4">
              <span className="flex items-center gap-2 text-[14px] text-black/60">
                <Mark animated={false} className="size-4 text-black" />
                The Binary Labs team
              </span>
              <span className="text-[12px] text-black/40">Nov 2026</span>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
