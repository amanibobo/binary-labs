import type { ReactNode } from "react";
import { PALETTE, type SeriesColor, type Stroke } from "@/lib/charts";
import { LABEL_FONT, TICK_FONT, TITLE_FONT, type DrawColor, type Plot } from "@/lib/chart-geometry";
import { exportFill, mixOklab, screenFill, type PlatePlot } from "@/lib/plate-geometry";

// The colors a chart is drawn in. On screen they're the theme's CSS variables, so a chart
// follows light and dark; an exported file carries the light hex values, as a printed figure.
export type ChartInk = {
  series: Record<DrawColor, string>;
  // Each hue mixed most of the way to the surface: a bar behind its own dots.
  soft: Record<DrawColor, string>;
  surface: string;
  grid: string;
  axis: string;
  tick: string;
  label: string;
  title: string;
  font: string;
  // A page background behind an exported chart; on screen the page is the background.
  background: string | null;
  // A flagged value on a run-history chart.
  flag: string;
  // A plate well's color at a place on the scale, 0 to 1.
  ramp: (t: number) => string;
  // The ramp's stops for the scale's bar, low to high.
  rampStops: readonly string[];
};

function byColor(color: (slot: SeriesColor) => string, muted: string): Record<DrawColor, string> {
  return {
    blue: color("blue"),
    orange: color("orange"),
    aqua: color("aqua"),
    violet: color("violet"),
    magenta: color("magenta"),
    green: color("green"),
    muted,
  };
}

export const SCREEN_INK: ChartInk = {
  series: byColor((slot) => `var(--chart-${slot})`, "var(--content-tertiary)"),
  soft: byColor((slot) => `color-mix(in oklab, var(--chart-${slot}) 28%, var(--background-primary))`, "color-mix(in oklab, var(--content-tertiary) 28%, var(--background-primary))"),
  surface: "var(--background-primary)",
  grid: "var(--border-opaque)",
  axis: "var(--border-raised)",
  tick: "var(--content-tertiary)",
  label: "var(--content-secondary)",
  title: "var(--content-primary)",
  font: "inherit",
  background: null,
  flag: "var(--chart-flag)",
  ramp: screenFill,
  rampStops: [0, 1, 2, 3, 4].map((i) => `var(--chart-seq-${i})`),
};

// The light tokens from globals.css; chart-ink.test.ts checks they still match.
export const EXPORT_INK: ChartInk = {
  series: byColor((slot) => PALETTE[slot].light, "#66666c"),
  soft: byColor((slot) => mixOklab(PALETTE[slot].light, "#ffffff", 0.72), mixOklab("#66666c", "#ffffff", 0.72)),
  surface: "#ffffff",
  grid: "#e6e6e8",
  axis: "#dadadd",
  tick: "#66666c",
  label: "#4b4b50",
  title: "#18181a",
  font: "Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  background: "#ffffff",
  flag: "#b26f00",
  ramp: exportFill,
  rampStops: [0, 0.25, 0.5, 0.75, 1].map(exportFill),
};

// A dashed line's pattern; solid lines have none.
export const DASH: Record<Stroke, string | undefined> = { solid: undefined, dashed: "6 4" };

const CAP = 3;

export function ChartSvg({
  plot,
  ink,
  clipId,
  label,
  children,
}: {
  plot: Plot;
  ink: ChartInk;
  // Unique per chart on the page.
  clipId: string;
  label: string;
  // The hover layer, drawn over the marks.
  children?: ReactNode;
}) {
  const { area } = plot;
  const bottom = area.top + area.height;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={plot.width}
      height={plot.height}
      viewBox={`0 0 ${plot.width} ${plot.height}`}
      role="img"
      aria-label={label}
      fontFamily={ink.font}
      style={{ display: "block", fontVariantNumeric: "tabular-nums" }}
    >
      {ink.background === null ? null : <rect width={plot.width} height={plot.height} fill={ink.background} />}
      <defs>
        <clipPath id={clipId}>
          <rect x={area.left - 6} y={area.top - 6} width={area.width + 12} height={area.height + 12} />
        </clipPath>
      </defs>
      {plot.title === null ? null : (
        <text x={plot.title.x} y={plot.title.y} fontSize={TITLE_FONT} fontWeight={600} fill={ink.title}>
          {plot.title.text}
        </text>
      )}
      <g>
        {plot.yTicks.map((t) => (
          <line key={`g${t.label}`} x1={area.left} x2={area.left + area.width} y1={t.pos} y2={t.pos} stroke={ink.grid} strokeWidth={1} shapeRendering="crispEdges" />
        ))}
        <line
          x1={area.left}
          x2={area.left + area.width}
          y1={plot.baseline ?? bottom}
          y2={plot.baseline ?? bottom}
          stroke={ink.axis}
          strokeWidth={1}
          shapeRendering="crispEdges"
        />
      </g>
      <g fontSize={TICK_FONT} fill={ink.tick}>
        {plot.yTicks.map((t) => (
          <text key={`y${t.label}`} x={area.left - 8} y={t.pos} textAnchor="end" dominantBaseline="middle">
            {t.label}
          </text>
        ))}
        {plot.xTicks.map((t, i) => (
          <text key={`x${i}`} x={t.pos} y={bottom + TICK_FONT + 6} textAnchor="middle">
            {t.label}
          </text>
        ))}
      </g>
      <g fontSize={LABEL_FONT} fill={ink.label}>
        {plot.xTitle === null ? null : (
          <text x={plot.xTitle.x} y={plot.xTitle.y} textAnchor="middle" fill={plot.xTitle.placeholder ? ink.tick : undefined}>
            {plot.xTitle.text}
          </text>
        )}
        {plot.yTitle === null ? null : (
          <text
            x={plot.yTitle.x}
            y={plot.yTitle.y}
            textAnchor="middle"
            transform={`rotate(-90 ${plot.yTitle.x} ${plot.yTitle.y})`}
            fill={plot.yTitle.placeholder ? ink.tick : undefined}
          >
            {plot.yTitle.text}
          </text>
        )}
      </g>
      <g clipPath={`url(#${clipId})`}>
        {plot.series.map((s) => {
          const color = ink.series[s.color];
          return (
            <g key={s.column}>
              {s.bars.map((b) => (
                <path key={b.row} d={b.path} fill={color} />
              ))}
              {s.whiskers.map((w, i) => (
                <path
                  key={i}
                  d={`M${w.px} ${w.top}V${w.bottom}M${w.px - CAP} ${w.top}H${w.px + CAP}M${w.px - CAP} ${w.bottom}H${w.px + CAP}`}
                  stroke={color}
                  strokeWidth={1.5}
                  fill="none"
                />
              ))}
              {s.path === null ? null : (
                <path
                  d={s.path}
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray={DASH[s.stroke]}
                  fill="none"
                  strokeLinejoin="round"
                  strokeLinecap={s.stroke === "dashed" ? "butt" : "round"}
                />
              )}
              {s.markers ? s.points.map((p) => <Marker key={p.row} x={p.px} y={p.py} color={color} stroke={s.stroke} surface={ink.surface} />) : null}
            </g>
          );
        })}
      </g>
      <g fontSize={TICK_FONT} fill={ink.label}>
        {plot.series.map((s) =>
          s.label === null ? null : (
            <text key={s.column} x={s.label.x} y={s.label.y} dominantBaseline="middle">
              {s.name}
            </text>
          ),
        )}
      </g>
      {plot.legend.length === 0 ? null : (
        <g fontSize={TICK_FONT} fill={ink.label}>
          {plot.legend.map((item) => (
            <g key={`${item.name}-${item.color}-${item.stroke}`}>
              <LegendMark mark={plot.legendMark} x={item.x} y={item.y} color={ink.series[item.color]} stroke={item.stroke} surface={ink.surface} />
              <text x={item.x + 22} y={item.y} dominantBaseline="middle">
                {item.name}
              </text>
            </g>
          ))}
        </g>
      )}
      {children}
    </svg>
  );
}

// A dot on a line or a scatter: filled for a solid series, a ring for a dashed one.
export function Marker({ x, y, r = 4, color, stroke, surface }: { x: number; y: number; r?: number; color: string; stroke: Stroke; surface: string }) {
  return stroke === "dashed" ? (
    <circle cx={x} cy={y} r={r - 0.5} fill={surface} stroke={color} strokeWidth={2} />
  ) : (
    <circle cx={x} cy={y} r={r} fill={color} stroke={surface} strokeWidth={2} />
  );
}

function LegendMark({
  mark,
  x,
  y,
  color,
  stroke,
  surface,
}: {
  mark: Plot["legendMark"];
  x: number;
  y: number;
  color: string;
  stroke: Stroke;
  surface: string;
}) {
  switch (mark) {
    case "line":
      return (
        <line
          x1={x}
          x2={x + 16}
          y1={y}
          y2={y}
          stroke={color}
          strokeWidth={2}
          strokeDasharray={stroke === "dashed" ? "5 3" : undefined}
          strokeLinecap={stroke === "dashed" ? "butt" : "round"}
        />
      );
    case "dot":
      return <Marker x={x + 8} y={y} color={color} stroke={stroke} surface={surface} />;
    case "bar":
      return <rect x={x + 3} y={y - 5} width={10} height={10} rx={2} fill={color} />;
    default: {
      const _exhaustive: never = mark;
      return _exhaustive;
    }
  }
}

// A plate heatmap: a circle per well colored along the ramp, row letters and column numbers,
// and the scale under it. A well the table doesn't give is an empty ring.
export function PlateSvg({
  plot,
  ink,
  gradientId,
  label,
  children,
}: {
  plot: PlatePlot;
  ink: ChartInk;
  gradientId: string;
  label: string;
  children?: ReactNode;
}) {
  const { scale } = plot;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={plot.width}
      height={plot.height}
      viewBox={`0 0 ${plot.width} ${plot.height}`}
      role="img"
      aria-label={label}
      fontFamily={ink.font}
      style={{ display: "block", fontVariantNumeric: "tabular-nums" }}
    >
      {ink.background === null ? null : <rect width={plot.width} height={plot.height} fill={ink.background} />}
      <defs>
        <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
          {ink.rampStops.map((color, i) => (
            <stop key={i} offset={i / (ink.rampStops.length - 1)} stopColor={color} style={{ stopColor: color }} />
          ))}
        </linearGradient>
      </defs>
      {plot.title === null ? null : (
        <text x={plot.title.x} y={plot.title.y} fontSize={TITLE_FONT} fontWeight={600} fill={ink.title}>
          {plot.title.text}
        </text>
      )}
      <g fontSize={TICK_FONT} fill={ink.tick}>
        {plot.columnLabels.map((l, i) =>
          l.slant ? (
            <text key={`c${i}`} x={l.x} y={l.y} textAnchor="start" transform={`rotate(-45 ${l.x} ${l.y})`}>
              {l.text}
            </text>
          ) : (
            <text key={`c${i}`} x={l.x} y={l.y} textAnchor="middle">
              {l.text}
            </text>
          ),
        )}
        {plot.rowLabels.map((l) => (
          <text key={`r${l.text}`} x={l.x} y={l.y} textAnchor="end" dominantBaseline="middle">
            {l.text}
          </text>
        ))}
      </g>
      <g>
        {plot.wells.map((w) => {
          if (plot.shape === "square") {
            const side = plot.pitch - 2;
            return w.t === null ? (
              <rect key={w.name} x={w.cx - side / 2 + 0.5} y={w.cy - side / 2 + 0.5} width={side - 1} height={side - 1} rx={2} fill="none" stroke={ink.axis} strokeWidth={1} />
            ) : (
              <rect key={w.name} x={w.cx - side / 2} y={w.cy - side / 2} width={side} height={side} rx={2} fill={ink.ramp(w.t)} />
            );
          }
          return w.t === null ? (
            <circle key={w.name} cx={w.cx} cy={w.cy} r={plot.radius - 0.5} fill="none" stroke={ink.axis} strokeWidth={1} />
          ) : (
            <circle key={w.name} cx={w.cx} cy={w.cy} r={plot.radius} fill={ink.ramp(w.t)} />
          );
        })}
      </g>
      {scale === null ? null : (
        <g fontSize={TICK_FONT}>
          <rect x={scale.left} y={scale.top} width={scale.width} height={scale.height} rx={2} fill={`url(#${gradientId})`} />
          {scale.ticks.map((t) => (
            <g key={t.label}>
              <line x1={t.pos} x2={t.pos} y1={scale.top + scale.height} y2={scale.top + scale.height + 4} stroke={ink.axis} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={t.pos} y={scale.top + scale.height + 6 + TICK_FONT} textAnchor="middle" fill={ink.tick}>
                {t.label}
              </text>
            </g>
          ))}
          {scale.title === "" ? null : (
            <text x={scale.left} y={scale.top + scale.height + 6 + TICK_FONT * 2 + 8} fill={scale.placeholder ? ink.tick : ink.label} fontSize={LABEL_FONT}>
              {scale.title}
            </text>
          )}
        </g>
      )}
      {children}
    </svg>
  );
}
