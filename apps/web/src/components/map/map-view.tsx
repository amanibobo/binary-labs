"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  ALL_KINDS,
  describe,
  fileNodeId,
  filesText,
  findNodes,
  globalGraph,
  KIND_NAMES,
  listSections,
  localGraph,
  localMapHref,
  NODE_KINDS,
  nodeName,
  openHref,
  openLabel,
  type Depth,
  type Filters,
  type Graph,
  type HubFiles,
  type HubView,
  type LocalView,
  type MapNode,
  type MapNodeId,
  type NamedNode,
  type NodeKind,
} from "@/lib/map";
import { useDebounced } from "@/lib/use-debounced";
import { SearchOutlineIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { buttonVariants } from "../ui/button";
import { MapCanvas } from "./map-canvas";

// `open` and `similar` are where the map starts: hubs already showing their files, and
// similar-in-meaning edges on.
export type MapMode =
  | { kind: "global"; view: HubView; open?: readonly MapNodeId[]; similar?: boolean }
  | { kind: "local"; view: LocalView; centerName: string; similar?: boolean };

export function MapView({ mode }: { mode: MapMode }) {
  return mode.kind === "global" ? (
    <GlobalMap view={mode.view} initialOpen={mode.open ?? []} initialSimilar={mode.similar ?? false} />
  ) : (
    <LocalMap initial={mode.view} centerName={mode.centerName} initialSimilar={mode.similar ?? false} />
  );
}

function useFilters(initialSimilar: boolean) {
  const [kinds, setKinds] = useState<ReadonlySet<NodeKind>>(ALL_KINDS);
  const [similar, setSimilar] = useState(initialSimilar);
  const toggleKind = (kind: NodeKind) =>
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  const filters: Filters = useMemo(() => ({ kinds, similar }), [kinds, similar]);
  return { filters, toggleKind, setSimilar };
}

// The lab map: the hubs, and the files of the ones someone opened.
function GlobalMap({ view, initialOpen, initialSimilar }: { view: HubView; initialOpen: readonly MapNodeId[]; initialSimilar: boolean }) {
  const api = useLabApi();
  const router = useRouter();
  const { filters, toggleKind, setSimilar } = useFilters(initialSimilar);
  const [open, setOpen] = useState<readonly MapNodeId[]>(initialOpen);
  const results = useQueries({
    queries: open.map((id) => {
      const others = filters.similar ? open.filter((o) => o !== id) : [];
      return {
        queryKey: ["map-hub", id, filters.similar, others] as const,
        queryFn: ({ signal }: { signal: AbortSignal }) => api.mapHub({ id, similar: filters.similar, with: others }, signal),
        staleTime: 60_000,
        placeholderData: (previous: HubFiles | undefined) => previous,
      };
    }),
  });
  const loaded = results.map((r) => r.data).filter((d): d is HubFiles => d !== undefined);
  const loadedKey = loaded.map((d) => `${d.hub}:${d.nodes.length}:${d.edges.length}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt only when what's loaded changes
  const graph = useMemo(() => globalGraph({ view, open: loaded, filters }), [view, loadedKey, filters]);
  const loading = results.some((r) => r.isFetching);
  const toggleHub = (id: MapNodeId) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  const empty = view.hubs.length === 0;
  return (
    <MapFrame
      graph={graph}
      title="Map"
      filters={filters}
      toggleKind={toggleKind}
      setSimilar={setSimilar}
      loading={loading}
      onActivate={(node) => {
        if (node.kind === "file" || node.kind === "more") router.push(openHref(node));
        else toggleHub(node.id);
      }}
      onPick={(node) => {
        if (node.kind !== "file" && node.kind !== "more" && !open.includes(node.id)) toggleHub(node.id);
      }}
      hubActions={(node) =>
        node.kind === "file" || node.kind === "more" ? null : (
          <button type="button" onClick={() => toggleHub(node.id)} className={cn(buttonVariants({ variant: "secondary", size: "compact" }))}>
            {open.includes(node.id) ? "Hide its files" : "Show its files"}
          </button>
        )
      }
      summary={
        empty
          ? "Nothing to map yet. Files show up here once they're labeled with an experiment, a person or an instrument, or attached to a protocol."
          : `${filesText(view.files)}, ${view.linked.toLocaleString("en-US")} linked to something. Click an experiment, person, protocol or instrument to show its files.`
      }
    />
  );
}

// The map around one file, protocol, experiment, person or instrument.
function LocalMap({ initial, centerName, initialSimilar }: { initial: LocalView; centerName: string; initialSimilar: boolean }) {
  const api = useLabApi();
  const router = useRouter();
  const { filters, toggleKind, setSimilar } = useFilters(initialSimilar);
  const [depth, setDepth] = useState<Depth>(initial.depth);
  const fresh = depth === initial.depth && !filters.similar;
  const query = useQuery({
    queryKey: ["map-local", initial.center, depth, filters.similar] as const,
    queryFn: ({ signal }) => api.mapLocal({ around: initial.center, depth, similar: filters.similar }, signal),
    initialData: fresh ? initial : undefined,
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  });
  const view = query.data ?? initial;
  const graph = useMemo(() => localGraph({ view, filters }), [view, filters]);
  const count = [...graph.nodes.values()].filter((n) => n.kind !== "more" && n.id !== graph.center).length;
  return (
    <MapFrame
      graph={graph}
      title={`Map around ${centerName}`}
      filters={filters}
      toggleKind={toggleKind}
      setSimilar={setSimilar}
      loading={query.isFetching}
      onActivate={(node) => router.push(openHref(node))}
      onPick={() => undefined}
      depth={{ value: depth, set: setDepth }}
      hubActions={() => null}
      summary={count === 0 ? `Nothing links to ${centerName} yet.` : `${count.toLocaleString("en-US")} things within ${depth === 1 ? "one step" : "two steps"} of ${centerName}.`}
    />
  );
}

function MapFrame({
  graph,
  title,
  filters,
  toggleKind,
  setSimilar,
  loading,
  onActivate,
  onPick,
  hubActions,
  summary,
  depth,
  initialActive = null,
}: {
  graph: Graph;
  title: string;
  filters: Filters;
  toggleKind: (k: NodeKind) => void;
  setSimilar: (v: boolean) => void;
  loading: boolean;
  onActivate: (node: MapNode) => void;
  onPick: (node: MapNode) => void;
  hubActions: (node: MapNode) => ReactNode;
  summary: string;
  depth?: { value: Depth; set: (d: Depth) => void };
  initialActive?: MapNodeId | null;
}) {
  const [active, setActive] = useState<MapNodeId | null>(initialActive);
  const [centerOn, setCenterOn] = useState<MapNodeId | null>(null);
  const [asList, setAsList] = useState(false);
  const ids = useId();
  const stripId = `${ids}-strip`;
  const helpId = `${ids}-help`;
  const activeNode = active === null ? undefined : graph.nodes.get(active);
  const pick = (node: MapNode) => {
    onPick(node);
    setActive(node.id);
    setCenterOn(node.id);
  };
  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col md:h-dvh">
      <div className="flex flex-col gap-3 border-b border-border-opaque px-4 pt-4 pb-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="min-w-0 truncate text-heading-small">{title}</h1>
          {loading ? <span className="text-paragraph-xsmall text-content-tertiary">Loading…</span> : null}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              aria-pressed={asList}
              onClick={() => setAsList((v) => !v)}
              className={buttonVariants({ variant: "tertiary", size: "compact" })}
            >
              {asList ? "Show as a map" : "Show as a list"}
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <MapSearch graph={graph} onPick={pick} />
          <div className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
            <KindFilters graph={graph} kinds={filters.kinds} toggle={toggleKind} />
            <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border-opaque" />
            <Toggle label="Similar in meaning" on={filters.similar} onChange={setSimilar} dashed />
            {depth === undefined ? null : (
              <>
                <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border-opaque" />
                <div role="group" aria-label="How far out" className="flex shrink-0 items-center rounded-control bg-background-secondary p-0.5">
                  {([1, 2] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={depth.value === d}
                      onClick={() => depth.set(d)}
                      className={cn(
                        "min-h-10 rounded-[6px] px-2.5 text-label-small sm:min-h-7",
                        depth.value === d ? "bg-background-raised text-content-primary shadow-raised" : "text-content-secondary hover:text-content-primary",
                      )}
                    >
                      {d === 1 ? "1 step" : "2 steps"}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {asList ? (
        <MapList graph={graph} />
      ) : (
        <>
          <p id={helpId} className="sr-only">
            Arrow keys move between dots, Enter opens the one you&apos;re on, plus and minus zoom, 0 fits the map. Show as a list reads the same links as text.
          </p>
          <MapCanvas
            className="flex-1 bg-background-primary"
            graph={graph}
            active={active}
            onActiveChange={setActive}
            onActivate={onActivate}
            centerOn={centerOn}
            label={title}
            describedBy={`${helpId} ${stripId}`}
          />
        </>
      )}

      <div id={stripId} aria-live="polite" className="min-h-[76px] border-t border-border-opaque bg-background-primary px-4 py-3 sm:px-6">
        {activeNode === undefined ? (
          <p className="text-paragraph-small text-content-tertiary">{summary}</p>
        ) : (
          <NodeStrip node={activeNode} graph={graph} actions={hubActions(activeNode)} />
        )}
      </div>
    </div>
  );
}

function NodeStrip({ node, graph, actions }: { node: MapNode; graph: Graph; actions: ReactNode }) {
  const links = graph.edges.filter((e) => e.source === node.id || e.target === node.id).length;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-label-medium text-content-primary">{nodeName(node)}</p>
        <p className="truncate text-paragraph-xsmall text-content-tertiary">
          {node.kind === "more" ? "Not drawn, to keep the map readable" : describe(node)}
          {node.kind === "more" ? null : ` · ${links === 1 ? "1 link" : `${links} links`} on the map`}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {actions}
        {node.kind === "more" || node.id === graph.center ? null : (
          <Link href={localMapHref(node.id)} className={buttonVariants({ variant: "secondary", size: "compact" })}>
            Map around this
          </Link>
        )}
        <Link href={openHref(node)} className={buttonVariants({ size: "compact" })}>
          {openLabel(node)}
        </Link>
      </div>
    </div>
  );
}

function Dot({ kind, dashed }: { kind: NodeKind | "similar"; dashed?: boolean }) {
  if (dashed) return <span aria-hidden className="inline-block w-3.5 shrink-0 border-t border-dashed border-content-tertiary" />;
  const ring = kind === "instrument";
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-full", ring ? "border-2" : "")}
      style={ring ? { borderColor: `var(--map-${kind})` } : { background: `var(--map-${kind})` }}
    />
  );
}

// The type filters double as the legend: each names its kind beside its dot.
function KindFilters({ graph, kinds, toggle }: { graph: Graph; kinds: ReadonlySet<NodeKind>; toggle: (k: NodeKind) => void }) {
  const counts = new Map<NodeKind, number>();
  for (const n of graph.nodes.values()) {
    const k = n.kind === "more" ? "file" : n.kind;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return (
    <div role="group" aria-label="Show on the map" className="flex shrink-0 items-center gap-1">
      {NODE_KINDS.map((kind) => (
        <Toggle key={kind} label={KIND_NAMES[kind].many} on={kinds.has(kind)} onChange={() => toggle(kind)} kind={kind} />
      ))}
      <span className="sr-only">{[...counts].map(([k, n]) => `${n} ${KIND_NAMES[k].many.toLowerCase()}`).join(", ")} shown</span>
    </div>
  );
}

function Toggle({ label, on, onChange, kind, dashed }: { label: string; on: boolean; onChange: (v: boolean) => void; kind?: NodeKind; dashed?: boolean }) {
  return (
    <button
      type="button"
      role={dashed ? "switch" : undefined}
      aria-checked={dashed ? on : undefined}
      aria-pressed={dashed ? undefined : on}
      onClick={() => onChange(!on)}
      className={cn(
        "flex min-h-10 shrink-0 items-center gap-2 rounded-control px-2.5 text-label-small transition-colors duration-150 ease-out sm:min-h-8",
        on ? "bg-background-secondary text-content-primary" : "text-content-tertiary hover:text-content-secondary",
      )}
    >
      {dashed ? <Dot kind="similar" dashed /> : kind === undefined ? null : <span className={cn("flex", on ? "" : "opacity-40")}><Dot kind={kind} /></span>}
      {label}
    </button>
  );
}

// Finds a dot on the map by name; files that aren't drawn are found in the lab and open their
// own map.
function MapSearch({ graph, onPick }: { graph: Graph; onPick: (node: MapNode) => void }) {
  const api = useLabApi();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const listId = useId();
  const settled = useDebounced(q.trim(), 200);
  const onMap = findNodes(graph, q, 6);
  const elsewhere = useQuery({
    queryKey: ["map-search", settled],
    queryFn: ({ signal }) => api.search({ q: settled }, signal),
    enabled: settled.length >= 2,
    staleTime: 30_000,
  });
  const shown = new Set(onMap.map((n) => n.id));
  const files = (elsewhere.data?.results ?? []).filter((h) => !shown.has(fileNodeId(h.sha256))).slice(0, 4);
  const choose = (node: NamedNode) => {
    setOpen(false);
    setQ(node.name);
    onPick(node);
  };
  const hasResults = onMap.length > 0 || files.length > 0;
  return (
    <div className="relative w-full lg:w-72 lg:shrink-0">
      <SearchOutlineIcon className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-content-tertiary" />
      <input
        type="search"
        role="combobox"
        aria-expanded={open && hasResults}
        aria-controls={listId}
        aria-label="Find on the map"
        placeholder="Find on the map"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onMap[0] !== undefined) choose(onMap[0]);
          if (e.key === "Escape") setOpen(false);
        }}
        className="h-11 w-full rounded-control border border-border-opaque bg-background-raised pr-3 pl-10 text-paragraph-small text-content-primary placeholder:text-content-tertiary focus:border-content-tertiary focus-visible:outline-none sm:h-9 [&::-webkit-search-cancel-button]:hidden"
      />
      {open && hasResults ? (
        <ul id={listId} role="listbox" className="absolute top-full right-0 left-0 z-20 mt-1 max-h-80 overflow-auto rounded-control border border-border-opaque bg-background-raised py-1 shadow-raised">
          {onMap.map((node) => (
            <li key={node.id} role="option" aria-selected={false}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(node)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-background-secondary">
                <Dot kind={node.kind} />
                <span className="min-w-0 flex-1 truncate text-paragraph-small text-content-primary">{nodeName(node)}</span>
                <span className="shrink-0 text-paragraph-xsmall text-content-tertiary">{KIND_NAMES[node.kind].one}</span>
              </button>
            </li>
          ))}
          {files.map((hit) => (
            <li key={hit.sha256} role="option" aria-selected={false}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => router.push(localMapHref(fileNodeId(hit.sha256)))}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-background-secondary"
              >
                <Dot kind="file" />
                <span className="min-w-0 flex-1 truncate text-paragraph-small text-content-primary">{hit.label?.cleanName ?? hit.locations[0].originalName}</span>
                <span className="shrink-0 text-paragraph-xsmall text-content-tertiary">Its map</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The same nodes and links as text, for screen readers and anyone who'd rather read.
function MapList({ graph }: { graph: Graph }) {
  const sections = listSections(graph);
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-6">
      <div className="mx-auto grid max-w-3xl gap-8">
        {sections.map((s) => (
          <section key={s.kind} aria-labelledby={`map-list-${s.kind}`}>
            <h2 id={`map-list-${s.kind}`} className="flex items-center gap-2 text-label-medium text-content-primary">
              <Dot kind={s.kind} />
              {s.title} <span className="text-content-tertiary">{s.items.length.toLocaleString("en-US")}</span>
            </h2>
            <ul className="mt-2 divide-y divide-border-opaque">
              {s.items.slice(0, 500).map(({ node, links }) => (
                <li key={node.id} className="py-2">
                  <Link href={openHref(node)} className="text-paragraph-small text-content-primary underline-offset-2 hover:underline">
                    {nodeName(node)}
                  </Link>
                  {node.kind === "more" ? null : <span className="ml-2 text-paragraph-xsmall text-content-tertiary">{describe(node)}</span>}
                  {links.length === 0 ? null : (
                    <p className="mt-0.5 text-paragraph-xsmall text-content-secondary">
                      Linked to {links.slice(0, 8).map(nodeName).join(", ")}
                      {links.length > 8 ? ` and ${links.length - 8} more` : ""}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {s.items.length > 500 ? <p className="mt-2 text-paragraph-xsmall text-content-tertiary">First 500 of {s.items.length.toLocaleString("en-US")}.</p> : null}
          </section>
        ))}
      </div>
    </div>
  );
}
