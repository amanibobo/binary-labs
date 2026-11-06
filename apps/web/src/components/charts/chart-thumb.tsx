import { useMemo } from "react";
import type { ChartSpec, ChartType } from "@/lib/charts";
import { plotChart } from "@/lib/chart-geometry";
import type { DataTable } from "@/lib/data-tables";
import { plotPlate } from "@/lib/plate-geometry";
import { DASH, SCREEN_INK } from "./chart-svg";

// A small picture of a chart of the student's own data, marks only, for the first question's
// choices. No axes or words: it's there to be recognized, and the choice's words say the rest.
export function ChartThumb({ spec, table, className }: { spec: ChartSpec; table: DataTable; className?: string }) {
  const art = useMemo(() => {
    if (spec.type === "heatmap") {
      const plot = plotPlate(spec, table, { width: 300, height: 220 });
      const pad = plot.pitch / 2;
      return {
        box: `${plot.plate.left - pad} ${plot.plate.top - pad} ${plot.plate.width + pad * 2} ${plot.plate.height + pad * 2}`,
        marks: plot.wells.map((w) =>
          w.t === null ? null : <circle key={w.name} cx={w.cx} cy={w.cy} r={plot.radius} fill={SCREEN_INK.ramp(w.t)} />,
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
          <line x1={area.left} x2={area.left + area.width} y1={plot.baseline ?? area.top + area.height} y2={plot.baseline ?? area.top + area.height} stroke={SCREEN_INK.axis} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {plot.series.map((s) => {
            const color = SCREEN_INK.series[s.color];
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
  }, [spec, table]);
  return (
    <svg aria-hidden viewBox={art.box} preserveAspectRatio="xMidYMid meet" className={className}>
      {art.marks}
    </svg>
  );
}

const glyph = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

// The kind of chart as a 24px glyph, beside its name in the builder's panel.
export function ChartKindGlyph({ type, className }: { type: ChartType; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className ?? "size-5 shrink-0"}>
      {type === "line" ? <path {...glyph} d="M4 17.5 9 11l4 3.5L20 6" /> : null}
      {type === "bar" ? <path {...glyph} d="M5.5 19.5v-6M10 19.5V6.5M14.5 19.5v-9M19 19.5v-4" strokeWidth={2.5} /> : null}
      {type === "scatter" ? (
        <g fill="currentColor">
          <circle cx="6" cy="17" r="1.6" />
          <circle cx="9.5" cy="13.5" r="1.6" />
          <circle cx="13" cy="12" r="1.6" />
          <circle cx="15.5" cy="8.5" r="1.6" />
          <circle cx="19" cy="6" r="1.6" />
        </g>
      ) : null}
      {type === "heatmap" ? (
        <g fill="currentColor">
          {[0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => <circle key={`${r}${c}`} cx={5.5 + c * 4.3} cy={7.5 + r * 4.5} r={1.6} opacity={0.35 + ((r + c) % 3) * 0.3} />))}
        </g>
      ) : null}
    </svg>
  );
}
