"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { GelArt, KindIcon, NotebookArt, PlateArt, ProtocolArt } from "./art";
import { useInView, useReducedMotion } from "./motion";
import { DEMO_SCRIPT, FILES, searchSamples, type FileId, type Hit, type Preview } from "./samples";

type Demo =
  | { mode: "auto"; step: number; typed: number; phase: "typing" | "searching" | "showing" }
  | { mode: "manual"; query: string };

const TICK = { type: 55, settle: 260, search: 520, show: 3200 } as const;
const RECENT: readonly Hit[] = [
  { id: "lysisNotebook", why: "Opened yesterday" },
  { id: "sdsProtocol", why: "Opened Monday" },
  { id: "bradfordPlate", why: "Opened last week" },
];

function scriptAt(step: number) {
  return DEMO_SCRIPT[step % DEMO_SCRIPT.length] ?? { query: "", hits: [] };
}

function next(demo: Demo): Demo | null {
  if (demo.mode === "manual") return null;
  const { query } = scriptAt(demo.step);
  if (demo.phase === "typing") {
    return demo.typed < query.length ? { ...demo, typed: demo.typed + 1 } : { ...demo, phase: "searching" };
  }
  if (demo.phase === "searching") return { ...demo, phase: "showing" };
  return { mode: "auto", step: demo.step + 1, typed: 0, phase: "typing" };
}

function delayFor(demo: Demo): number {
  if (demo.mode === "manual") return 0;
  if (demo.phase === "typing") return demo.typed < scriptAt(demo.step).query.length ? TICK.type : TICK.settle;
  return demo.phase === "searching" ? TICK.search : TICK.show;
}

type View = { query: string; caret: boolean; list: "recent" | "searching" | "hits"; hits: readonly Hit[]; listKey: string };

function viewOf(demo: Demo, reduced: boolean): View {
  if (demo.mode === "manual") {
    const hits = searchSamples(demo.query);
    return demo.query.trim()
      ? { query: demo.query, caret: false, list: "hits", hits, listKey: demo.query }
      : { query: "", caret: false, list: "recent", hits: RECENT, listKey: "recent" };
  }
  if (reduced) {
    const first = scriptAt(0);
    return { query: first.query, caret: false, list: "hits", hits: first.hits, listKey: "reduced" };
  }
  const script = scriptAt(demo.step);
  const query = script.query.slice(0, demo.typed);
  if (demo.phase === "showing") return { query, caret: false, list: "hits", hits: script.hits, listKey: `step-${demo.step}` };
  if (demo.phase === "searching") return { query, caret: false, list: "searching", hits: [], listKey: "searching" };
  return { query, caret: true, list: demo.step === 0 ? "recent" : "hits", hits: demo.step === 0 ? RECENT : scriptAt(demo.step - 1).hits, listKey: `typing-${demo.step}` };
}

const PREVIEW_ART: Record<Preview, (props: { className: string }) => ReactNode> = {
  gel: GelArt,
  plate: PlateArt,
  protocol: ProtocolArt,
  notebook: NotebookArt,
};

function PreviewPane({ id }: { id: FileId | undefined }) {
  if (!id) {
    return <div className="grid h-full place-items-center px-6 text-center text-[13px] text-black/40">Nothing matches yet.</div>;
  }
  const file = FILES[id];
  const Art = PREVIEW_ART[file.preview];
  const places = "places" in file ? file.places : undefined;
  return (
    <div key={id} className="hero-in flex h-full flex-col gap-3 p-4" style={{ "--enter-delay": "0.05s" } as CSSProperties}>
      <div className="overflow-hidden rounded-[10px] border border-black/10 bg-[#f4f4f5]">
        <Art className="block aspect-[4/3] h-auto w-full" />
      </div>
      <div className="min-w-0">
        <p className="text-[14px] font-medium leading-[1.3] tracking-[-0.3px]">{file.clean}</p>
        <p className="mt-1 truncate font-mono text-[11px] text-black/45">
          {file.folder}/{file.original}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {file.tags.slice(0, 3).map((t) => (
          <span key={t} className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] text-black/60">
            {t}
          </span>
        ))}
        {places && <span className="rounded-full bg-[#e5eefd] px-2 py-0.5 text-[11px] text-[#1d4fa8]">Saved in {places} folders, counted once</span>}
      </div>
    </div>
  );
}

function ResultRow({ hit, index, selected }: { hit: Hit; index: number; selected: boolean }) {
  const file = FILES[hit.id];
  return (
    <li
      className={`hero-in flex items-start gap-3 rounded-[10px] px-3 py-2.5 ${selected ? "bg-[#eef3fd]" : ""}`}
      style={{ "--enter-delay": `${index * 0.07}s` } as CSSProperties}
    >
      <KindIcon kind={file.kind} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium leading-[1.3] tracking-[-0.3px]">{file.clean}</p>
        <p className="truncate font-mono text-[11px] leading-[1.6] text-black/45">{file.original}</p>
        <p className="mt-0.5 truncate text-[12px] text-[#2563a6]">{hit.why}</p>
      </div>
    </li>
  );
}

// The hero's product window: a search over sample lab files that types its own queries until
// someone clicks in, then searches whatever they type.
export function SearchDemo() {
  const reduced = useReducedMotion();
  const [frameRef, inView] = useInView<HTMLDivElement>({ once: false, margin: "0px" });
  const inputRef = useRef<HTMLInputElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const [demo, setDemo] = useState<Demo>({ mode: "auto", step: 0, typed: 0, phase: "typing" });
  const playing = demo.mode === "auto" && inView && !reduced;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setDemo((d) => next(d) ?? d), delayFor(demo));
    return () => window.clearTimeout(timer);
  }, [playing, demo]);

  const view = viewOf(demo, reduced);
  const auto = demo.mode === "auto";

  function follow(e: PointerEvent<HTMLDivElement>) {
    const frame = frameRef.current;
    const pill = pillRef.current;
    if (!frame || !pill || !auto || e.pointerType !== "mouse") return;
    const box = frame.getBoundingClientRect();
    pill.style.setProperty("--gx", `${e.clientX - box.left}px`);
    pill.style.setProperty("--gy", `${e.clientY - box.top}px`);
    frame.dataset.follow = "";
  }

  function unfollow() {
    delete frameRef.current?.dataset.follow;
  }

  function takeOver() {
    if (demo.mode === "manual") return;
    unfollow();
    setDemo({ mode: "manual", query: view.query });
    requestAnimationFrame(() => inputRef.current?.select());
  }

  return (
    <div
      ref={frameRef}
      onPointerMove={follow}
      onPointerLeave={unfollow}
      onClick={() => {
        takeOver();
        inputRef.current?.focus();
      }}
      className={`search-frame @container relative w-full overflow-hidden rounded-[16px] border border-black bg-white shadow-[0_10px_24px_rgb(0_0_0/0.12)] after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_1px_1px_rgb(255_255_255/0.8)] ${auto ? "cursor-pointer" : ""}`}
    >
      <label className="flex h-[58px] items-center gap-3 border-b border-black/10 px-4 @2xl:px-5">
        <svg viewBox="0 0 16 16" className="size-[17px] shrink-0 text-black/45" aria-hidden>
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.8 10.8l3.4 3.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span className="sr-only">Search the sample lab files</span>
        <span className="relative min-w-0 flex-1">
          <input
            ref={inputRef}
            value={view.query}
            readOnly={auto}
            onFocus={takeOver}
            onChange={(e) => setDemo({ mode: "manual", query: e.target.value })}
            placeholder="Search your lab’s files"
            spellCheck={false}
            autoComplete="off"
            className={`w-full bg-transparent text-[17px] tracking-[-0.4px] outline-none placeholder:text-black/35 ${view.caret ? "text-transparent" : ""}`}
          />
          {view.caret && (
            <span aria-hidden className="caret pointer-events-none absolute inset-y-0 left-0 flex items-center text-[17px] tracking-[-0.4px] whitespace-pre">
              {view.query}
            </span>
          )}
        </span>
        <kbd className="hidden rounded-[6px] border border-black/10 px-1.5 py-0.5 font-sans text-[12px] text-black/40 @md:block">⌘K</kbd>
      </label>

      <div className="grid h-[306px] grid-cols-1 @2xl:h-[380px] @2xl:grid-cols-[1fr_300px]">
        <div className="min-h-0 overflow-hidden px-2 py-2.5 @2xl:px-3">
          <p className="px-3 pb-1.5 text-[12px] text-black/40">
            {view.list === "recent" ? "Recent" : view.list === "searching" ? "Searching…" : `${view.hits.length} ${view.hits.length === 1 ? "file" : "files"}`}
          </p>
          {view.list === "searching" ? (
            <ul aria-hidden className="space-y-1">
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="size-[30px] rounded-[8px] bg-black/[0.06]" />
                  <span className="flex-1 space-y-2">
                    <span className="block h-[10px] w-3/5 rounded-full bg-black/[0.07]" />
                    <span className="block h-[8px] w-2/5 rounded-full bg-black/[0.05]" />
                  </span>
                </li>
              ))}
            </ul>
          ) : view.hits.length === 0 ? (
            <p className="px-3 py-2 text-[14px] text-black/50">No sample files match. Try “gel”, “Bradford” or “notebook”.</p>
          ) : (
            <ul key={view.listKey} className="space-y-0.5">
              {view.hits.slice(0, 4).map((hit, i) => (
                <ResultRow key={hit.id} hit={hit} index={i} selected={i === 0 && view.list === "hits"} />
              ))}
            </ul>
          )}
        </div>
        <aside className="hidden min-h-0 border-l border-black/10 bg-[#fafafa] @2xl:block">
          <PreviewPane id={view.list === "searching" ? undefined : view.hits[0]?.id} />
        </aside>
      </div>

      {auto && (
        <span ref={pillRef} aria-hidden className="try-pill glass">
          <span className="gloss" />
          <svg viewBox="0 0 16 16" className="size-[18px]">
            <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M10.8 10.8l3.4 3.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span>Try a search</span>
        </span>
      )}
    </div>
  );
}
