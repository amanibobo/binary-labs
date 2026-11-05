"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BadgeArt, BinArt, CloudArt, FlaskArt, FolderArt, GelArt, KindIcon, NotebookArt, PlateArt, ProtocolArt, RotorArt, type Tint } from "./art";
import { Dish } from "./dish";
import { APP_URL, PILOT_MAILTO } from "./links";
import { useReducedMotion } from "./motion";
import { FILES, type FileId } from "./samples";
import { SearchDemo } from "./search-demo";

// Positions are drawn on a 1440 px wide desktop, measured from the top of the hero. `mobile` places
// the few items that stay on a phone, as an offset from the centre line.
type Place = { x: number; y: number; w: number; rotate?: number; mobile?: { x: number; y: number; w: number } };
type Screen = "gel" | "plate" | "notebook" | "protocol" | "capture";
type FolderId = keyof typeof FOLDERS;

type DeskItem = Place &
  (
    | { kind: "window"; id: string; h: number; screen: Screen; caption: string; label: string }
    | { kind: "folder"; id: FolderId; tint: Tint }
    | { kind: "art"; id: string; draw: () => ReactNode }
    | { kind: "rotor"; id: string }
    | { kind: "scrap"; id: string; text: string; size: number }
    | { kind: "tag"; id: string; tint: Tint; top: string; bottom: string }
  );

const FOLDERS = {
  protocols: { title: "Protocols", files: ["bradfordProtocol", "sdsProtocol", "lysisNotebook"] },
  gels: { title: "Gels", files: ["gelOct12", "gelOct14", "expressionNotes"] },
} as const satisfies Record<string, { title: string; files: readonly FileId[] }>;

const DESK: readonly DeskItem[] = [
  { kind: "art", id: "plate-tile", x: 20, y: 73, w: 114, draw: () => <PlateArt className="block h-[69px] w-full rounded-[3px]" /> },
  { kind: "art", id: "dish", x: 446, y: 128, w: 76, draw: () => <Dish /> },
  { kind: "tag", id: "tag-blue", x: 314, y: 22, w: 78, rotate: 4, tint: "blue", top: "P450 · b3", bottom: "Oct 12", mobile: { x: -136, y: 14, w: 80 } },
  { kind: "window", id: "gel", x: 527, y: 25, w: 182, h: 131, screen: "gel", caption: "IMG_4821.jpg", label: "2026-10-12 P450 gel, batch 3" },
  { kind: "scrap", id: "temp", x: 366, y: 112, w: 70, rotate: -8, text: "37 °C", size: 24 },
  { kind: "scrap", id: "ph", x: 867, y: 77, w: 60, rotate: -7.7, text: "pH 7.4", size: 16 },
  { kind: "art", id: "cloud", x: 858, y: 108, w: 58, draw: () => <CloudArt className="block h-auto w-full" />, mobile: { x: -190, y: 92, w: 48 } },
  { kind: "rotor", id: "rotor", x: 802, y: 190, w: 28, mobile: { x: -182, y: 18, w: 30 } },
  { kind: "window", id: "plate", x: 996, y: 62, w: 250, h: 148, screen: "plate", caption: "plate_reader_0930.xlsx", label: "Bradford plate, standard curve" },
  { kind: "tag", id: "tag-orange", x: 1232, y: 136, w: 104, rotate: -7.5, tint: "orange", top: "BL-0427", bottom: "Bradford std", mobile: { x: 134, y: 90, w: 88 } },
  { kind: "art", id: "badge", x: 1326, y: 34, w: 92, draw: () => <BadgeArt className="block h-auto w-full" /> },
  { kind: "window", id: "notebook", x: 125, y: 75, w: 123, h: 235, screen: "notebook", caption: "IMG_3310.jpg", label: "Notebook p. 42, lysis buffer" },
  { kind: "art", id: "bin", x: 38, y: 266, w: 58, draw: () => <BinArt className="block h-auto w-full" /> },
  { kind: "folder", id: "protocols", x: 306, y: 212, w: 50, tint: "blue", mobile: { x: -74, y: 50, w: 42 } },
  { kind: "window", id: "protocol", x: 38, y: 405, w: 222, h: 150, screen: "protocol", caption: "bradford_FINAL(2).pdf", label: "Bradford assay, protocol v4" },
  { kind: "scrap", id: "spin", x: 287, y: 458, w: 70, rotate: -7.7, text: "×1000 g", size: 16 },
  { kind: "art", id: "flask", x: 178, y: 584, w: 92, rotate: 18, draw: () => <FlaskArt className="block h-auto w-full" />, mobile: { x: 152, y: 4, w: 42 } },
  { kind: "scrap", id: "od", x: 1132, y: 388, w: 110, rotate: 7, text: "OD₆₀₀ 0.6", size: 24 },
  { kind: "window", id: "capture", x: 1262, y: 378, w: 147, h: 277, screen: "capture", caption: "IMG_5002.HEIC", label: "Gel from the bench, batch 3" },
  { kind: "folder", id: "gels", x: 1150, y: 470, w: 52, tint: "purple", mobile: { x: 132, y: 44, w: 42 } },
  { kind: "art", id: "gel-tile", x: 1196, y: 535, w: 76, draw: () => <GelArt className="block h-[46px] w-full rounded-[3px]" />, mobile: { x: 64, y: 56, w: 66 } },
];

const DESIGN_WIDTH = 1440;

function placeStyle({ x, y, w, mobile }: Place, index: number): CSSProperties {
  const anchorRight = x + w / 2 > DESIGN_WIDTH / 2;
  return {
    "--l": anchorRight ? "auto" : `${(x / DESIGN_WIDTH) * 100}%`,
    "--r": anchorRight ? `${((DESIGN_WIDTH - x - w) / DESIGN_WIDTH) * 100}%` : "auto",
    "--t": `${y}px`,
    "--w": `${w}px`,
    "--ml": mobile ? `calc(50% + ${mobile.x}px)` : "0px",
    "--mt": mobile ? `${mobile.y}px` : "0px",
    "--mw": mobile ? `${mobile.w}px` : "0px",
    "--enter-delay": `${0.11 + index * 0.016}s`,
  } as CSSProperties;
}

function Lights() {
  return (
    <span className="lights" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

function CloseX() {
  return (
    <svg viewBox="0 0 8 7" className="win-close-x" aria-hidden>
      <path d="M1 0.5l6 6M7 0.5l-6 6" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ScreenArt({ screen }: { screen: Screen }) {
  const fill = "absolute inset-0 h-full w-full";
  switch (screen) {
    case "gel":
      return <GelArt className={fill} />;
    case "plate":
      return <PlateArt className={fill} />;
    case "notebook":
      return <NotebookArt className={fill} />;
    case "protocol":
      return <ProtocolArt className={fill} step={1} />;
    case "capture":
      return (
        <div className={`${fill} bg-[linear-gradient(160deg,#6b4a2f,#3b2716_60%,#2a1b10)]`}>
          <div className="absolute inset-x-[14%] top-[22%] bottom-[30%] rotate-[-4deg] overflow-hidden rounded-[4px] shadow-[0_6px_14px_rgb(0_0_0/0.45)] ring-1 ring-white/20">
            <GelArt className="h-full w-full" />
          </div>
          <div className="absolute inset-x-[30%] bottom-[8%] h-[14%] rounded-[3px] bg-[#e9e2d0] opacity-80" />
        </div>
      );
  }
}

// A desktop object you can pick up and drop anywhere. A press that never moves counts as a tap.
function Draggable({
  item,
  index,
  raise,
  onTap,
  dim,
  focused,
  children,
}: {
  item: DeskItem;
  index: number;
  raise: () => number;
  onTap?: (el: HTMLElement) => void;
  dim: boolean;
  focused: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const offset = useRef({ x: 0, y: 0 });
  const press = useRef<{ px: number; py: number; moved: boolean } | null>(null);

  return (
    <div
      ref={ref}
      data-dim={dim ? "" : undefined}
      data-focused={focused ? "" : undefined}
      className={`desk-item hero-in absolute top-[var(--mt)] left-[var(--ml)] w-[var(--mw)] lg:top-[var(--t)] lg:right-[var(--r)] lg:left-[var(--l)] lg:w-[var(--w)] ${item.mobile ? "" : "max-lg:hidden"} ${item.kind === "window" ? "desk-win" : ""}`}
      style={{ ...placeStyle(item, index), zIndex: focused ? 100 : undefined }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        press.current = { px: e.clientX, py: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        const el = ref.current;
        if (!p || !el) return;
        const dx = e.clientX - p.px;
        const dy = e.clientY - p.py;
        if (!p.moved) {
          if (Math.hypot(dx, dy) < 4) return;
          p.moved = true;
          el.dataset.dragging = "";
          el.style.zIndex = String(raise());
        }
        el.style.translate = `${offset.current.x + dx}px ${offset.current.y + dy}px`;
      }}
      onPointerUp={(e) => {
        const p = press.current;
        press.current = null;
        if (!p || !ref.current) return;
        if (!p.moved) {
          onTap?.(e.currentTarget);
          return;
        }
        offset.current = { x: offset.current.x + e.clientX - p.px, y: offset.current.y + e.clientY - p.py };
        delete ref.current.dataset.dragging;
      }}
      onPointerCancel={() => {
        press.current = null;
        if (ref.current) {
          delete ref.current.dataset.dragging;
          ref.current.style.translate = `${offset.current.x}px ${offset.current.y}px`;
        }
      }}
    >
      <div style={item.rotate ? { rotate: `${item.rotate}deg` } : undefined}>{children}</div>
    </div>
  );
}

function DeskWindow({ item, playing }: { item: Extract<DeskItem, { kind: "window" }>; playing: boolean }) {
  return (
    <div className="flex flex-col items-center">
      <div className="win w-full">
        <div className="win-bar">
          <Lights />
          <CloseX />
        </div>
        <div className="win-screen" style={{ height: item.h - 34 }}>
          <ScreenArt screen={item.screen} />
          {playing && (
            <>
              <span aria-hidden className="scan" />
              <span className="hero-in absolute inset-x-1.5 bottom-1.5 z-[2] rounded-[6px] bg-white/90 px-2 py-1 text-[11px] leading-[1.3] font-medium tracking-[-0.2px] shadow-[0_4px_10px_rgb(0_0_0/0.18)]" style={{ "--enter-delay": "0.5s" } as CSSProperties}>
                {item.label}
              </span>
            </>
          )}
        </div>
      </div>
      <p className="win-caption">{item.caption}</p>
    </div>
  );
}

function Tag({ tint, top, bottom }: { tint: Tint; top: string; bottom: string }) {
  const band = tint === "blue" ? "#1b49ed" : "#e0582a";
  return (
    <div className="overflow-hidden rounded-[3px] border border-white bg-white shadow-[0_0.7px_1.4px_rgb(0_0_0/0.25)]">
      <div className="px-1.5 py-[3px] text-center text-[8px] leading-[1.15] font-bold text-white" style={{ background: band }}>
        Sample
      </div>
      <div className="px-1.5 pt-1.5 pb-1 text-center">
        <p className="font-mono text-[11px] leading-tight font-semibold whitespace-nowrap text-black/85">{top}</p>
        <p className="font-mono text-[9px] leading-tight whitespace-nowrap text-black/50">{bottom}</p>
      </div>
      <div className="h-[7px]" style={{ background: band }} />
    </div>
  );
}

function FolderModal({ id, origin, onClosed }: { id: FolderId; origin: HTMLElement; onClosed: () => void }) {
  const folder = FOLDERS[id];
  const reduced = useReducedMotion();
  const winRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);

  const fromTransform = useCallback(() => {
    const win = winRef.current;
    if (!win) return "none";
    const a = origin.getBoundingClientRect();
    const b = win.getBoundingClientRect();
    const dx = a.left + a.width / 2 - (b.left + b.width / 2);
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${a.width / b.width}, ${a.height / b.height})`;
  }, [origin]);

  useLayoutEffect(() => {
    const win = winRef.current;
    if (!win) return;
    closeRef.current?.focus({ preventScroll: true });
    if (reduced) return;
    win.animate([{ transform: fromTransform(), opacity: 0.3 }, { transform: "none", opacity: 1 }], {
      duration: 360,
      easing: "cubic-bezier(0.2, 0.7, 0.25, 1)",
    });
  }, [fromTransform, reduced]);

  const close = useCallback(() => {
    const win = winRef.current;
    if (closing.current || !win) return;
    closing.current = true;
    if (backdropRef.current) backdropRef.current.dataset.closing = "";
    const done = () => {
      onClosed();
      origin.focus({ preventScroll: true });
    };
    if (reduced) return done();
    const anim = win.animate([{ transform: "none", opacity: 1 }, { transform: fromTransform(), opacity: 0.2 }], {
      duration: 300,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      fill: "forwards",
    });
    anim.onfinish = done;
  }, [fromTransform, onClosed, origin, reduced]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return createPortal(
    <div ref={backdropRef} className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div ref={winRef} role="dialog" aria-modal="true" aria-label={`${folder.title} folder`} className="modal-win win w-[min(92vw,560px)]">
        <div className="win-bar">
          <span className="lights">
            <button
              ref={closeRef}
              type="button"
              aria-label="Close"
              onClick={close}
              className="relative block size-[10px] rounded-full bg-[radial-gradient(circle_at_50%_30%,#ff8a80,#ff5f57_60%,#e0443e)] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.25)] before:absolute before:-inset-[17px] before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d6ee5]"
            />
            <i />
            <i />
          </span>
          <span className="win-title">{folder.title}</span>
          <CloseX />
        </div>
        <div className="win-screen bg-white p-2">
          <ul>
            {folder.files.map((fileId, i) => {
              const file = FILES[fileId];
              return (
                <li key={fileId} className="hero-in flex items-center gap-3 rounded-[8px] px-2.5 py-2.5 odd:bg-black/[0.025]" style={{ "--enter-delay": `${0.12 + i * 0.06}s` } as CSSProperties}>
                  <KindIcon kind={file.kind} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium tracking-[-0.3px]">{file.clean}</p>
                    <p className="truncate font-mono text-[11px] text-black/45">
                      saved as {file.original}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="px-2.5 pt-2 pb-1 text-[12px] text-black/45">Clean names are labels. The files in Dropbox keep the names you gave them.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type Stage = { kind: "idle" } | { kind: "window"; id: string } | { kind: "folder"; id: FolderId; origin: HTMLElement };

export function Hero() {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const top = useRef(10);
  const raise = useCallback(() => ++top.current, []);

  useEffect(() => {
    if (stage.kind !== "window") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setStage({ kind: "idle" });
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.("[data-focused]")) setStage({ kind: "idle" });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [stage.kind]);

  const focusedId = stage.kind === "window" ? stage.id : null;

  function render(item: DeskItem): { node: ReactNode; onTap?: (el: HTMLElement) => void; label?: string } {
    switch (item.kind) {
      case "window": {
        const toggle = () => setStage((s) => (s.kind === "window" && s.id === item.id ? { kind: "idle" } : { kind: "window", id: item.id }));
        return { node: <DeskWindow item={item} playing={focusedId === item.id} />, onTap: toggle, label: `${item.caption}, labeled ${item.label}` };
      }
      case "folder": {
        const open = (el: HTMLElement) => setStage({ kind: "folder", id: item.id, origin: el.closest("button") ?? el.querySelector("button") ?? el });
        return { node: <FolderArt tint={item.tint} className="block h-auto w-full drop-shadow-[0_2px_3px_rgb(0_0_0/0.15)]" />, onTap: open, label: `Open the ${FOLDERS[item.id].title} folder` };
      }
      case "art":
        return { node: item.draw() };
      case "rotor":
        return { node: <RotorArt className="rotor block h-auto w-full drop-shadow-[0_1px_2px_rgb(0_0_0/0.4)]" /> };
      case "scrap":
        return { node: <p className="text-center leading-none whitespace-nowrap" style={{ fontSize: item.size, letterSpacing: `${-0.03 * item.size}px` }}>{item.text}</p> };
      case "tag":
        return { node: <Tag tint={item.tint} top={item.top} bottom={item.bottom} /> };
    }
  }

  return (
    <section id="top" className="dot-grid relative isolate overflow-hidden lg:h-[1012px]" aria-label="Binary Labs">
      {DESK.map((item, index) => {
        const { node, onTap, label } = render(item);
        const target = item.kind === "folder" || item.kind === "window" ? item : null;
        return (
          <Draggable
            key={item.id}
            item={item}
            index={index}
            raise={raise}
            dim={focusedId !== null && focusedId !== item.id}
            focused={focusedId === item.id}
            onTap={onTap}
          >
            {target && onTap ? (
              <button
                type="button"
                aria-label={label}
                className="flex min-h-11 w-full min-w-11 cursor-[inherit] flex-col justify-center rounded-[8px] text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1d6ee5]"
                onClick={(e) => e.detail === 0 && onTap(e.currentTarget)}
              >
                {node}
              </button>
            ) : (
              <div aria-hidden>{node}</div>
            )}
          </Draggable>
        );
      })}

      <div className="pointer-events-none relative z-[1] flex flex-col items-center px-5 pt-[112px] pb-16 lg:px-0 lg:pt-[236px] lg:pb-0">
        <div className="hero-in flex flex-col items-center gap-6 lg:gap-8" style={{ "--enter-delay": "0.05s" } as CSSProperties}>
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-center text-[56px] leading-[1.1] font-medium tracking-[-0.03em] whitespace-nowrap lg:text-[88px] lg:tracking-[-2.64px]">Binary Labs</h1>
            <p className="max-w-[340px] text-center text-[18px] leading-[1.5] tracking-[-0.54px] text-pretty lg:w-[620px] lg:max-w-none lg:text-[20px] lg:tracking-[-0.6px]">
              An assistant that remembers everything your lab has done.
            </p>
          </div>
          <div className="pointer-events-auto flex flex-col items-center gap-4 lg:flex-row lg:items-start">
            <div className="flex flex-col items-center gap-2">
              <a href={PILOT_MAILTO} className="aqua aqua-blue min-w-[220px] lg:w-[218px]">
                <span className="gloss" />
                <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
                  <ellipse cx="10" cy="9" rx="8" ry="3.4" fill="#ffd84f" stroke="#000" strokeWidth="1.3" />
                  <path d="M2 9v2.6c0 1.9 3.6 3.4 8 3.4s8-1.5 8-3.4V9" fill="#f6a91c" stroke="#000" strokeWidth="1.3" />
                  <circle cx="7.5" cy="8.6" r="1.1" fill="#fff" />
                  <circle cx="12" cy="9.4" r="0.8" fill="#fff" />
                </svg>
                <span>Request a pilot</span>
              </a>
              <p className="text-[12px] tracking-[-0.36px] text-black/40">Free for a month. Twenty minutes of setup.</p>
            </div>
            <div className="flex flex-col items-center gap-2">
              <a href={APP_URL} className="aqua aqua-grey min-w-[220px] lg:w-[218px]">
                <span className="gloss" />
                <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
                  <circle cx="7" cy="10" r="4" fill="none" stroke="#000" strokeWidth="1.6" />
                  <path d="M11 10h7M15.5 10v3M18 10v2.2" stroke="#000" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>Sign in</span>
              </a>
              <p className="text-[12px] tracking-[-0.36px] text-black/40">For labs already in the pilot.</p>
            </div>
          </div>
        </div>

        <div
          data-dim={focusedId ? "" : undefined}
          className="hero-in pointer-events-auto mt-10 w-full max-w-[353px] transition-opacity duration-350 data-[dim]:opacity-30 sm:max-w-[560px] lg:mt-[56px] lg:w-[800px] lg:max-w-none"
          style={{ "--enter-delay": "0s" } as CSSProperties}
        >
          <SearchDemo />
          <p className="win-caption">Search, with sample files. Click in to try your own words.</p>
        </div>
      </div>

      {stage.kind === "folder" && <FolderModal key={stage.id} id={stage.id} origin={stage.origin} onClosed={() => setStage({ kind: "idle" })} />}
    </section>
  );
}
