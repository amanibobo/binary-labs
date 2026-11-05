"use client";

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { GelArt, KindIcon } from "./art";
import { Mark } from "./mark";
import { useReducedMotion } from "./motion";

// A row's conversation: someone asks out loud, the mark pops up, the answer lands.
type Talk = { phase: "idle" } | { phase: "asking"; typed: number } | { phase: "thinking" } | { phase: "answered" };
type Phase = Talk["phase"];

type Feature = {
  id: string;
  title: string;
  body: ReactNode;
  ask: string;
  reply: string;
  window: string;
  wall: string;
  Scene: (props: { phase: Phase }) => ReactNode;
};

const TIMING = { start: 450, perChar: 62, settle: 380, think: 950 } as const;

const WALLS = {
  agar: "radial-gradient(circle at 18% 72%, #fffaf0 0 2.4%, transparent 2.9%), radial-gradient(circle at 70% 24%, #fff3d0 0 4%, transparent 4.6%), radial-gradient(circle at 84% 78%, #fff6e0 0 1.8%, transparent 2.3%), radial-gradient(circle at 40% 40%, #ffd25a, #f4ad2a 60%, #e2901b)",
  sky: "radial-gradient(ellipse at 30% 110%, #3d9c62 0 30%, transparent 31%), radial-gradient(ellipse at 85% 120%, #2f8452 0 34%, transparent 35%), linear-gradient(#5d8fe6, #a9c8f5 55%, #dfeafb)",
  dusk: "radial-gradient(circle at 78% 26%, #fff2c4 0 6%, transparent 6.6%), linear-gradient(#7a68d6, #c79ad8 50%, #f0a07a)",
} as const;

function useTalk(active: boolean, ask: string): Talk {
  const reduced = useReducedMotion();
  const [talk, setTalk] = useState<Talk>({ phase: "idle" });
  useEffect(() => {
    if (reduced) return;
    const step = (t: Talk): [Talk, number] | null => {
      if (t.phase === "idle") return [{ phase: "asking", typed: 0 }, TIMING.start];
      if (t.phase === "asking") return t.typed < ask.length ? [{ phase: "asking", typed: t.typed + 1 }, TIMING.perChar] : [{ phase: "thinking" }, TIMING.settle];
      if (t.phase === "thinking") return [{ phase: "answered" }, TIMING.think];
      return null;
    };
    const next: [Talk, number] | null = active ? step(talk) : talk.phase === "idle" ? null : [{ phase: "idle" }, 420];
    if (!next) return;
    const timer = window.setTimeout(() => setTalk(next[0]), next[1]);
    return () => window.clearTimeout(timer);
  }, [active, reduced, ask, talk]);
  if (reduced) return active ? { phase: "answered" } : { phase: "idle" };
  return active ? talk : { phase: "idle" };
}

const BARS = [
  [10, 0.9, 0],
  [16, 0.7, 0.2],
  [22, 1.1, 0.1],
  [12, 0.8, 0.35],
  [28, 0.95, 0.05],
  [18, 0.75, 0.4],
  [26, 1.05, 0.15],
  [14, 0.85, 0.3],
  [24, 1.2, 0.25],
  [12, 0.7, 0.45],
  [18, 1, 0.1],
  [10, 0.8, 0.3],
] as const;

function Wave({ talking }: { talking: boolean }) {
  return (
    <div className="wave" data-talking={talking ? "" : undefined} aria-hidden>
      {BARS.map(([h, d, delay], i) => (
        <i key={i} style={{ "--h": `${h}px`, "--d": `${d}s`, "--delay": `-${delay}s` } as CSSProperties} />
      ))}
    </div>
  );
}

function Tail({ side }: { side: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 18 14"
      aria-hidden
      className={`bubble-tail ${side === "right" ? "right-[14px]" : "left-[14px] -scale-x-100"}`}
    >
      <path d="M1 -3V0C3 6 9 10 17 12 11 8 10 4 11 0V-3z" fill="var(--bubble-end)" />
      <path d="M1 0C3 6 9 10 17 12 11 8 10 4 11 0" fill="none" stroke="var(--bubble-edge)" strokeWidth="1" />
    </svg>
  );
}

function Bubble({ tone, side, children, caret = false, className = "" }: { tone: "blue" | "orange"; side: "left" | "right"; children: ReactNode; caret?: boolean; className?: string }) {
  return (
    <div className={`bubble bubble-${tone} ${className}`}>
      <span className="gloss" />
      <span className={caret ? "caret" : undefined}>{children}</span>
      <Tail side={side} />
    </div>
  );
}

function Chrome({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="feat-fig">
      <div className="win-bar">
        <span className="lights" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="win-title">{title}</span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[4.5px]">{children}</div>
    </div>
  );
}

// Lane 5 of the gel, where the batch 3 bands are.
function FindScene({ phase }: { phase: Phase }) {
  const shown = phase === "answered";
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#070b1c]">
      <div className="relative aspect-[320/220] h-full max-w-full">
        <GelArt className="absolute inset-0 h-full w-full" focusLane={shown ? 4 : undefined} />
        <svg viewBox="0 0 320 220" className="absolute inset-0 h-full w-full" aria-hidden>
          <ellipse
            cx="178"
            cy="122"
            rx="26"
            ry="58"
            fill="none"
            stroke="#ffd84f"
            strokeWidth="2.5"
            strokeDasharray="6 5"
            pathLength={300}
            style={{ strokeDashoffset: shown ? 0 : 300, opacity: shown ? 1 : 0, transition: "stroke-dashoffset 0.9s ease, opacity 0.2s" }}
          />
        </svg>
        <span
          className="absolute top-[14%] left-[63%] rounded-[8px] bg-[#ffd84f] px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap text-black shadow-[0_6px_14px_rgb(0_0_0/0.35)] transition-[opacity,translate] duration-500 lg:text-[14px]"
          style={{ opacity: shown ? 1 : 0, translate: shown ? "0 0" : "0 6px", transitionDelay: shown ? "0.5s" : "0s" }}
        >
          P450, batch 3, lane 5
        </span>
      </div>
      <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-[8px] bg-white/90 px-2.5 py-1.5 text-[11px] text-black/70 lg:text-[12px]">
        <span className="font-mono text-black/45">IMG_4821.jpg</span>
        <span>Text in the photo: “P450 b3”</span>
      </div>
    </div>
  );
}

const STEPS = ["Thaw the BSA standards on ice.", "Make eight standards, 0 to 2 mg/mL.", "Add 250 µL of dye to each well.", "Read absorbance at 595 nm.", "Fit the standard curve."] as const;

function ProtocolScene({ phase }: { phase: Phase }) {
  const shown = phase === "answered";
  return (
    <div className="absolute inset-0 flex gap-3 bg-[#eceff3] p-3 lg:gap-4 lg:p-5">
      <div className="min-w-0 flex-[1.4] rounded-[8px] bg-white p-3 shadow-[0_2px_8px_rgb(0_0_0/0.08)] lg:p-5">
        <p className="text-[13px] font-semibold tracking-[-0.3px] lg:text-[17px]">Bradford assay, protocol v4</p>
        <p className="mt-0.5 text-[10px] text-black/45 lg:text-[12px]">Updated by Jun, Sep 30</p>
        <ol className="mt-2 space-y-0.5 lg:mt-4 lg:space-y-1">
          {STEPS.map((step, i) => (
            <li
              key={step}
              className="flex items-baseline gap-2 rounded-[6px] px-1.5 py-1 text-[10px] leading-snug transition-colors duration-300 lg:text-[13px]"
              style={{ background: shown && i === 2 ? "#e5eefd" : "transparent" }}
            >
              <span className="w-3 shrink-0 text-black/40 tabular-nums">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
        <div className="relative aspect-video overflow-hidden rounded-[8px] bg-[linear-gradient(135deg,#2a3346,#11151f)] shadow-[0_4px_12px_rgb(0_0_0/0.2)]">
          <div className="absolute inset-x-[18%] top-[28%] bottom-[18%] rounded-[4px] bg-[#eef0f3]">
            <div className="grid h-full grid-cols-6 place-items-center gap-0.5 p-1">
              {Array.from({ length: 18 }, (_, i) => (
                <span key={i} className="size-[70%] rounded-full" style={{ background: `color-mix(in oklab, #3550c8 ${20 + ((i * 37) % 70)}%, #e6c76a)` }} />
              ))}
            </div>
          </div>
          <span className="absolute top-1/2 left-1/2 grid size-8 -translate-1/2 place-items-center rounded-full bg-white/85 lg:size-10">
            <svg viewBox="0 0 12 12" className="ml-0.5 size-3 lg:size-3.5" aria-hidden>
              <path d="M2.5 1.5v9l8-4.5z" fill="#000" />
            </svg>
          </span>
          <span className="absolute inset-x-2 bottom-2 h-[3px] rounded-full bg-white/25">
            <span className="block h-full rounded-full bg-white transition-[width] duration-[1.4s] ease-out" style={{ width: shown ? "34%" : "4%" }} />
          </span>
        </div>
        <p className="text-[10px] text-black/55 lg:text-[12px]">Jun’s walkthrough, 3:12</p>
        <p
          className="w-fit rounded-full bg-[#e5eefd] px-2 py-0.5 text-[10px] text-[#1d4fa8] transition-opacity duration-300 lg:text-[12px]"
          style={{ opacity: shown ? 1 : 0, transitionDelay: shown ? "0.4s" : "0s" }}
        >
          Step 3 starts at 1:04
        </p>
      </div>
    </div>
  );
}

function CaptureScene({ phase }: { phase: Phase }) {
  const shown = phase === "answered";
  return (
    <div className="absolute inset-0 flex items-center justify-center gap-4 bg-[#eceff3] p-3 lg:gap-8">
      <div className="relative aspect-[9/17] h-[92%] shrink-0 rounded-[22px] border-[5px] border-[#1b1b1d] bg-[#1b1b1d] shadow-[0_10px_24px_rgb(0_0_0/0.25)]">
        <div className="absolute inset-0 overflow-hidden rounded-[17px] bg-[linear-gradient(160deg,#6b4a2f,#3b2716_60%,#2a1b10)]">
          <div className="absolute inset-x-[12%] top-[20%] h-[38%] rotate-[-3deg] overflow-hidden rounded-[4px] ring-1 ring-white/25">
            <GelArt className="h-full w-full" />
          </div>
          <span className="absolute bottom-[5%] left-1/2 grid aspect-square w-[22%] -translate-x-1/2 place-items-center rounded-full border-[3px] border-white/90">
            <span className="block size-[78%] rounded-full bg-white/90" />
          </span>
          <span
            className="absolute inset-0 bg-white transition-opacity"
            style={{ opacity: phase === "thinking" ? 0.85 : 0, transitionDuration: phase === "thinking" ? "60ms" : "600ms" }}
          />
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 flex-col gap-2 sm:flex">
        <p className="text-[11px] text-black/45 lg:text-[12px]">Gels</p>
        <div
          className="flex items-center gap-3 rounded-[10px] bg-white p-2.5 shadow-[0_2px_8px_rgb(0_0_0/0.08)] transition-[opacity,translate] duration-500"
          style={{ opacity: shown ? 1 : 0, translate: shown ? "0 0" : "0 10px", transitionDelay: shown ? "0.2s" : "0s" }}
        >
          <KindIcon kind="image" />
          <div className="min-w-0">
            <p className="truncate text-[12px] font-medium lg:text-[14px]">2026-11-04 P450 gel, batch 3</p>
            <p className="truncate text-[10px] text-black/45 lg:text-[12px]">Lane 2 is the ladder</p>
          </div>
        </div>
        {["2026-10-14 P450 gel, batch 3, rerun", "2026-10-12 P450 gel, batch 3"].map((name) => (
          <div key={name} className="flex items-center gap-3 rounded-[10px] bg-white/70 p-2.5">
            <KindIcon kind="image" />
            <p className="truncate text-[12px] text-black/60 lg:text-[14px]">{name}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const FEATURES: readonly Feature[] = [
  {
    id: "find",
    title: "Ask the way you would ask a labmate",
    body: (
      <>
        It finds files by meaning and by name, even when the name is <span className="font-mono text-[0.9em]">final_v2_REAL.xlsx</span>, and
        shows you the place in the file that answered.
      </>
    ),
    ask: "Where are the P450 gels from batch 3?",
    reply: "Found six. This one is Oct 12.",
    window: "Preview",
    wall: WALLS.agar,
    Scene: FindScene,
  },
  {
    id: "teach",
    title: "Protocols a new student can follow",
    body: "Your lab’s protocols and tutorials in one place, with the walkthrough videos your last postdoc recorded linked to the steps they show.",
    ask: "How do we run the Bradford assay?",
    reply: "Protocol v4. Jun’s video shows step 3.",
    window: "Protocols",
    wall: WALLS.sky,
    Scene: ProtocolScene,
  },
  {
    id: "capture",
    title: "Capture from the bench",
    body: "Coming next. Take a photo of a gel or a notebook page and say what it is. It is labeled and searchable within a minute.",
    ask: "This is batch 3, lane two is the ladder.",
    reply: "Saved and labeled.",
    window: "Phone",
    wall: WALLS.dusk,
    Scene: CaptureScene,
  },
];

function Conversation({ feature, talk, right }: { feature: Feature; talk: Talk; right: boolean }) {
  const typed = talk.phase === "asking" ? feature.ask.slice(0, talk.typed) : talk.phase === "idle" ? "" : feature.ask;
  return (
    <div className={`flex flex-col gap-6 ${right ? "lg:items-end" : ""}`} data-talk={talk.phase}>
      <div className={`min-h-[60px] self-end ${right ? "" : "lg:self-start"}`}>
        {talk.phase !== "idle" && (
          <Bubble tone="blue" side="right" caret={talk.phase === "asking"} className="max-lg:max-w-[90%] max-lg:text-[20px] max-lg:tracking-[-0.4px]">
            {typed || "​"}
          </Bubble>
        )}
      </div>
      <div className={`flex flex-col items-start gap-3 ${right ? "lg:items-end" : ""}`}>
        <Mark animated={false} className="reply-mark ml-0.5 h-[20px] w-[20px] text-black" />
        <Bubble tone="orange" side="left" className="reply-bubble max-lg:text-[20px] max-lg:tracking-[-0.4px]">
          {feature.reply}
        </Bubble>
      </div>
    </div>
  );
}

function FeatureRow({ feature, right, active, rowRef }: { feature: Feature; right: boolean; active: boolean; rowRef: (el: HTMLDivElement | null) => void }) {
  const talk = useTalk(active, feature.ask);
  const { Scene } = feature;
  const copy = (
    <div className={`flex flex-col gap-2 pt-4 pb-10 max-lg:order-1 lg:p-0 ${right ? "lg:items-end lg:text-right" : ""}`}>
      <h3 className="text-[24px] leading-[1.3] font-medium tracking-[-0.72px] lg:text-[20px] lg:leading-[1.5] lg:tracking-[-0.6px]">{feature.title}</h3>
      <p className="text-[16px] leading-[1.5] tracking-[-0.48px] text-black/60">{feature.body}</p>
    </div>
  );
  return (
    <div
      ref={rowRef}
      data-dim={active ? undefined : ""}
      className={`feat-row flex flex-col px-5 pb-10 lg:items-center lg:gap-16 lg:p-0 ${right ? "lg:flex-row-reverse" : "lg:flex-row"}`}
    >
      <div className="contents lg:flex lg:h-[474px] lg:w-[320px] lg:shrink-0 lg:flex-col lg:p-4">
        <div className={`flex justify-center max-lg:order-3 max-lg:my-10 lg:h-[86px] lg:items-start ${right ? "lg:justify-end" : "lg:justify-start"}`}>
          <Wave talking={talk.phase === "asking"} />
        </div>
        <div className="flex flex-col max-lg:order-4 max-lg:h-[196px] lg:flex-1 lg:justify-center">
          <Conversation feature={feature} talk={talk} right={right} />
        </div>
        {copy}
      </div>
      <div className="relative aspect-[706/474] w-full max-lg:order-2 lg:h-[474px] lg:w-[706px] lg:shrink-0">
        <div className="feat-desktop" style={{ background: feature.wall }}>
          <Chrome title={feature.window}>
            <Scene phase={talk.phase} />
          </Chrome>
        </div>
      </div>
    </div>
  );
}

// Rows dim and shrink until they are the one nearest the middle of the screen.
export function Features() {
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const mid = window.innerHeight / 2;
      let best = -1;
      let bestDistance = Infinity;
      rows.current.forEach((row, i) => {
        if (!row) return;
        const box = row.getBoundingClientRect();
        if (box.bottom < 0 || box.top > window.innerHeight) return;
        const distance = Math.abs(box.top + box.height / 2 - mid);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      });
      setActive(best);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return (
    <section id="features" aria-label="How it works" className="scroll-mt-16 pt-6 lg:pt-[72px]">
      <div className="flex flex-col lg:items-center lg:gap-12 lg:px-16">
        {FEATURES.map((feature, i) => (
          <Fragment key={feature.id}>
            {i > 0 && <div aria-hidden className="section-stroke mx-5 mb-5 -mt-5 lg:hidden" />}
            <FeatureRow
              feature={feature}
              right={i % 2 === 1}
              active={active === i}
              rowRef={(el) => {
                rows.current[i] = el;
              }}
            />
          </Fragment>
        ))}
      </div>
    </section>
  );
}
