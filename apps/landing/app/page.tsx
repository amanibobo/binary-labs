const PILOT_MAILTO = "mailto:hello@binarylabs.example?subject=Pilot%20request";
const CALL_MAILTO = "mailto:hello@binarylabs.example?subject=Book%20a%20call";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

type Band = { y: number; strength: number };

// Lane 0 is the size ladder; the rest are samples with a strong band near the P450 weight.
const GEL_LANES: readonly (readonly Band[])[] = [
  [
    { y: 10, strength: 0.55 },
    { y: 16, strength: 0.55 },
    { y: 23, strength: 0.65 },
    { y: 31, strength: 0.55 },
    { y: 40, strength: 0.5 },
    { y: 49, strength: 0.45 },
  ],
  [{ y: 24, strength: 0.9 }, { y: 41, strength: 0.3 }],
  [{ y: 24, strength: 0.85 }, { y: 41, strength: 0.35 }],
  [{ y: 24, strength: 0.6 }, { y: 33, strength: 0.15 }],
  [{ y: 24, strength: 0.95 }, { y: 41, strength: 0.25 }],
  [{ y: 24, strength: 0.45 }],
];

const LANE_WIDTH = 9;
const LANE_PITCH = 12;

function GelThumbnail() {
  return (
    <svg
      viewBox="0 0 80 60"
      className="h-[54px] w-[72px] shrink-0 rounded-lg border border-line bg-gel text-ink"
    >
      {GEL_LANES.map((bands, lane) => {
        const x = 7 + lane * LANE_PITCH;
        return (
          <g key={lane}>
            <rect x={x} y={5} width={LANE_WIDTH} height={50} rx={1} fill="currentColor" opacity={0.05} />
            {bands.map((band) => (
              <rect
                key={band.y}
                x={x}
                y={band.y}
                width={LANE_WIDTH}
                height={lane === 0 ? 1.5 : 3}
                rx={1}
                fill="currentColor"
                opacity={band.strength * 0.8}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function Match({ children }: { children: string }) {
  return <mark className="bg-transparent text-blue">{children}</mark>;
}

const pill =
  "inline-flex h-9 items-center rounded-full px-4 text-[14px] font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue";
const pillPrimary = `${pill} bg-ink text-ground hover:bg-white`;
const pillQuiet = `${pill} bg-white/[0.06] text-ink hover:bg-white/[0.1]`;

function SearchExample() {
  return (
    <figure className="mx-auto mt-12 flex w-full max-w-[720px] items-center justify-center rounded-xl border border-line bg-panel px-3 py-10 sm:aspect-[12/5] sm:px-10 sm:py-0">
      <div aria-hidden="true" className="w-full max-w-[520px] overflow-hidden rounded-[10px] border border-line bg-surface text-left">
        <div className="flex h-12 items-center gap-3 border-b border-line px-4">
          <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-muted" fill="none">
            <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="text-[15px]">P450 gels from batch 3</span>
          <span className="-ml-2.5 h-5 w-px bg-blue" />
        </div>
        <div className="result-in flex items-center gap-4 p-4">
          <GelThumbnail />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium">
              <Match>P450</Match> SDS-PAGE <Match>gel</Match>, <Match>batch 3</Match>
            </p>
            <p className="mt-1 truncate font-mono text-[13px] text-muted">IMG_4821.jpg</p>
            <p className="mt-0.5 truncate font-mono text-[13px] text-muted">Dropbox/Imaging/2025-03</p>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        Example search for P450 gels from batch 3. The result is the file IMG_4821.jpg, labeled
        P450 SDS-PAGE gel, batch 3.
      </figcaption>
    </figure>
  );
}

export default function Home() {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden">
      <header className="relative flex h-20 items-center justify-center px-4 sm:h-[104px]">
        <p className="text-[17px] font-semibold tracking-[-0.03em]">Binary Labs</p>
        <a href={APP_URL} className={`${pillPrimary} absolute right-4 sm:right-8`}>
          Sign in
        </a>
      </header>

      <main className="mx-auto w-full max-w-[1080px] px-4 pt-6 text-center sm:pt-10">
        <h1 className="mx-auto max-w-[560px] text-[40px] leading-[0.95] font-medium tracking-[-0.055em] text-balance sm:max-w-[640px] sm:text-[48px]">
          An assistant that remembers everything your lab has done
        </h1>

        <SearchExample />

        <div className="mx-auto mt-14 max-w-[570px] text-[16px] leading-6 font-light tracking-[-0.02em] text-pretty text-muted">
          <p>
            Labs repeat experiments because nobody can find the last run. Binary Labs reads the
            Dropbox you already have and finds any file by what is in it, even one named{" "}
            <span className="font-mono text-[14px] tracking-normal">IMG_4821.jpg</span>.
          </p>
          <p className="mt-6">Nothing is moved, renamed or shared.</p>
        </div>

        <div className="mt-12 flex items-center justify-center gap-2">
          <a href={CALL_MAILTO} className={pillQuiet}>
            Book a call
          </a>
          <a href={PILOT_MAILTO} className={pillPrimary}>
            Request a pilot
          </a>
        </div>
      </main>

      <div aria-hidden="true" className="mt-auto pt-24 select-none sm:pt-32">
        <div className="h-[11vw] overflow-hidden">
          <p className="bg-gradient-to-b from-white/[0.13] to-white/0 bg-clip-text text-center text-[18vw] leading-[0.8] font-semibold tracking-[-0.06em] whitespace-nowrap text-transparent">
            Binary Labs
          </p>
        </div>
      </div>
    </div>
  );
}
