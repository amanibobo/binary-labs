const PILOT_MAILTO = "mailto:hello@binarylabs.example?subject=Pilot%20request";

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

function SearchExample() {
  return (
    <figure className="mt-16 overflow-hidden rounded-xl border border-line bg-surface sm:mt-20">
      <div aria-hidden="true">
        <div className="flex h-14 items-center gap-3 border-b border-line px-4">
          <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-muted" fill="none">
            <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="text-base">P450 gels from batch 3</span>
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
          <p className="hidden self-start text-[13px] text-muted sm:block">Mar 14, 2025</p>
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
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col px-4 pt-8 pb-16 sm:px-6 sm:pt-12 sm:pb-24">
      <p className="text-[15px] font-semibold tracking-[-0.01em]">Binary Labs</p>

      <section className="mt-24 sm:mt-32">
        <h1 className="text-[36px] leading-[1.05] font-medium tracking-[-0.035em] text-balance sm:text-[52px]">
          An assistant that remembers everything your lab has done.
        </h1>
        <p className="mt-6 max-w-[34rem] text-[17px] leading-[1.6] text-pretty text-muted">
          Binary Labs finds any file your lab has made by what is in it, even one named{" "}
          <span className="font-mono text-[15px]">IMG_4821.jpg</span>. It reads the Dropbox you
          already have and never moves or renames a thing.
        </p>
        <a
          href={PILOT_MAILTO}
          className="mt-8 inline-flex h-11 items-center rounded-[10px] bg-green px-5 text-[15px] font-medium text-on-green transition-colors duration-150 hover:bg-green-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
        >
          Request a pilot
        </a>
      </section>

      <SearchExample />
    </main>
  );
}
