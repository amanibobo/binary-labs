import { useMemo } from "react";
import { isScaled, isXY, type ChartSpec } from "@/lib/charts";
import { plotChart } from "@/lib/chart-geometry";
import type { DataTable } from "@/lib/data-tables";
import { plotScaled } from "@/lib/plate-geometry";
import type { ChartKind } from "@/lib/summary-guide";
import { plotSummary } from "@/lib/summary-geometry";
import { DASH, SCREEN_INK } from "./chart-svg";

// A small picture of a chart of the student's own data, marks only, for the first question's
// choices. No axes or words: it's there to be recognized, and the choice's words say the rest.
export function ChartThumb({ spec, table, tables, className }: { spec: ChartSpec; table: DataTable; tables?: readonly DataTable[]; className?: string }) {
  const art = useMemo(() => {
    const ink = SCREEN_INK;
    const line = (x1: number, x2: number, y: number) => <line x1={x1} x2={x2} y1={y} y2={y} stroke={ink.axis} strokeWidth={1} vectorEffect="non-scaling-stroke" />;
    if (isScaled(spec)) {
      const plot = plotScaled(spec, table, { width: 300, height: 220 });
      const pad = plot.pitch / 2;
      return {
        box: `${plot.plate.left - pad} ${plot.plate.top - pad} ${plot.plate.width + pad * 2} ${plot.plate.height + pad * 2}`,
        marks: plot.wells.map((w) => (w.t === null ? null : plot.shape === "square" ? <rect key={w.name} x={w.cx - plot.pitch / 2 + 1} y={w.cy - plot.pitch / 2 + 1} width={plot.pitch - 2} height={plot.pitch - 2} fill={ink.ramp(w.t)} /> : <circle key={w.name} cx={w.cx} cy={w.cy} r={plot.radius} fill={ink.ramp(w.t)} />)),
      };
    }
    if (!isXY(spec)) {
      const plot = plotSummary(spec, table, { width: 320, height: 200 }, {}, tables ?? [table]);
      const { area } = plot;
      const pad = 8;
      return {
        box: `${area.left - pad} ${area.top - pad} ${area.width + pad * 2} ${area.height + pad * 2}`,
        marks: (
          <>
            {line(area.left, area.left + area.width, plot.baseline ?? area.top + area.height)}
            {plot.bands.map((b, i) => (
              <path key={`b${i}`} d={b.path} fill={ink.series[b.color]} fillOpacity={0.16} />
            ))}
            {plot.bars.map((b, i) => (
              <path key={`r${i}`} d={b.path} fill={b.soft ? ink.soft[b.color] : ink.series[b.color]} />
            ))}
            {plot.boxes.map((b, i) => (
              <rect key={`x${i}`} x={b.x} y={Math.min(b.q1, b.q3)} width={b.width} height={Math.max(1, Math.abs(b.q1 - b.q3))} rx={3} fill={ink.soft[b.color]} stroke={ink.series[b.color]} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            ))}
            {plot.curves.map((c, i) => (
              <path key={`c${i}`} d={c.path} stroke={ink.series[c.color]} strokeWidth={2} fill="none" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            ))}
            {plot.dots.slice(0, 400).map((d, i) => (
              <circle key={`d${i}`} cx={d.px} cy={d.py} r={d.kind === "repeat" ? 2.5 : 4} fill={ink.series[d.color]} />
            ))}
          </>
        ),
      };
    }
    const plot = plotChart({ ...spec, legend: "bottom", series: spec.series.slice(0, 6) }, table, { width: 320, height: 180 });
    const { area } = plot;
    const pad = 8;
    return {
      box: `${area.left - pad} ${area.top - pad} ${area.width + pad * 2} ${area.height + pad * 2}`,
      marks: (
        <>
          {line(area.left, area.left + area.width, plot.baseline ?? area.top + area.height)}
          {plot.series.map((s) => {
            const color = ink.series[s.color];
            return (
              <g key={s.column}>
                {s.bars.map((b) => (
                  <path key={b.row} d={b.path} fill={color} />
                ))}
                {s.whiskers.map((w, i) => (
                  <path key={i} d={`M${w.px} ${w.top}V${w.bottom}`} stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                ))}
                {s.path === null ? null : (
                  <path d={s.path} stroke={color} strokeWidth={2} strokeDasharray={DASH[s.stroke]} fill="none" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                )}
                {spec.type === "scatter" ? s.points.map((p) => <circle key={p.row} cx={p.px} cy={p.py} r={4} fill={color} />) : null}
              </g>
            );
          })}
        </>
      ),
    };
  }, [spec, table, tables]);
  return (
    <svg aria-hidden viewBox={art.box} preserveAspectRatio="xMidYMid meet" className={className}>
      {art.marks}
    </svg>
  );
}

const glyph = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

// The kind of chart as a 24px glyph, beside its name in the builder's panel.
export function ChartKindGlyph({ type, className }: { type: ChartKind; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className ?? "size-5 shrink-0"}>
      {type === "line" ? <path {...glyph} d="M4 17.5 9 11l4 3.5L20 6" /> : null}
      {type === "bar" ? <path {...glyph} d="M5.5 19.5v-6M10 19.5V6.5M14.5 19.5v-9M19 19.5v-4" strokeWidth={2.5} /> : null}
      {type === "scatter" ? (
        <g>
          <path {...glyph} strokeWidth={1.25} d="M4.5 18.5 19.5 5.5" />
          <g fill="currentColor">
            <circle cx="6" cy="16" r="1.6" />
            <circle cx="10" cy="13.5" r="1.6" />
            <circle cx="13.5" cy="9.5" r="1.6" />
            <circle cx="18" cy="7.5" r="1.6" />
          </g>
        </g>
      ) : null}
      {type === "dose" ? <path {...glyph} d="M3.5 6.5h3c4 0 4.5 11 9 11h5" /> : null}
      {type === "box" ? (
        <g {...glyph}>
          <path d="M8 4v4M8 15v5M16 6v3M16 15v3" />
          <rect x="5" y="8" width="6" height="7" rx="1" />
          <rect x="13" y="9" width="6" height="6" rx="1" />
        </g>
      ) : null}
      {type === "histogram" ? <path {...glyph} strokeLinejoin="miter" d="M3.5 19.5v-4h3.4v-6h3.4v-5h3.4v7h3.4v4h3.4v4" /> : null}
      {type === "heatmap" ? (
        <g fill="currentColor">
          {[0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => <circle key={`${r}${c}`} cx={5.5 + c * 4.3} cy={7.5 + r * 4.5} r={1.6} opacity={0.35 + ((r + c) % 3) * 0.3} />))}
        </g>
      ) : null}
      {type === "grid" ? (
        <g fill="currentColor">
          {[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={5 + c * 5} y={5 + r * 5} width={4} height={4} rx={0.75} opacity={0.3 + ((r * 2 + c) % 3) * 0.32} />))}
        </g>
      ) : null}
    </svg>
  );
}
