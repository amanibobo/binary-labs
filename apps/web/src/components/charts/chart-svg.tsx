import type { ReactNode } from "react";
import { PALETTE, type SeriesColor } from "@/lib/charts";
import { LABEL_FONT, TICK_FONT, TITLE_FONT, type Plot } from "@/lib/chart-geometry";

// The colors a chart is drawn in. On screen they're the theme's CSS variables, so a chart
// follows light and dark; an exported file carries the light hex values, as a printed figure.
export type ChartInk = {
  series: Record<SeriesColor, string>;
  surface: string;
  grid: string;
  axis: string;
  tick: string;
  label: string;
  title: string;
  font: string;
  // A page background behind an exported chart; on screen the page is the background.
  background: string | null;
};

function byColor(color: (slot: SeriesColor) => string): Record<SeriesColor, string> {
  return {
    blue: color("blue"),
    orange: color("orange"),
    aqua: color("aqua"),
    violet: color("violet"),
    magenta: color("magenta"),
    green: color("green"),
  };
}

export const SCREEN_INK: ChartInk = {
  series: byColor((slot) => `var(--chart-${slot})`),
  surface: "var(--background-primary)",
  grid: "var(--border-opaque)",
  axis: "var(--border-raised)",
  tick: "var(--content-tertiary)",
  label: "var(--content-secondary)",
  title: "var(--content-primary)",
  font: "inherit",
  background: null,
};

// The light tokens from globals.css; chart-ink.test.ts checks they still match.
export const EXPORT_INK: ChartInk = {
  series: byColor((slot) => PALETTE[slot].light),
  surface: "#ffffff",
  grid: "#e6e6e8",
  axis: "#dadadd",
  tick: "#66666c",
  label: "#4b4b50",
  title: "#18181a",
  font: "Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  background: "#ffffff",
};

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
          <text x={plot.xTitle.x} y={plot.xTitle.y} textAnchor="middle">
            {plot.xTitle.text}
          </text>
        )}
        {plot.yTitle === null ? null : (
          <text x={plot.yTitle.x} y={plot.yTitle.y} textAnchor="middle" transform={`rotate(-90 ${plot.yTitle.x} ${plot.yTitle.y})`}>
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
                <path d={s.path} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
              )}
              {s.markers
                ? s.points.map((p) => <circle key={p.row} cx={p.px} cy={p.py} r={4} fill={color} stroke={ink.surface} strokeWidth={2} />)
                : null}
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
            <g key={item.name + item.color}>
              <LegendMark mark={plot.legendMark} x={item.x} y={item.y} color={ink.series[item.color]} />
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

function LegendMark({ mark, x, y, color }: { mark: Plot["legendMark"]; x: number; y: number; color: string }) {
  switch (mark) {
    case "line":
      return <line x1={x} x2={x + 16} y1={y} y2={y} stroke={color} strokeWidth={2} strokeLinecap="round" />;
    case "dot":
      return <circle cx={x + 8} cy={y} r={4} fill={color} />;
    case "bar":
      return <rect x={x + 3} y={y - 5} width={10} height={10} rx={2} fill={color} />;
    default: {
      const _exhaustive: never = mark;
      return _exhaustive;
    }
  }
}
