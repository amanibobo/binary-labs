import type { ReactNode } from "react";
import { LABEL_FONT, TICK_FONT, TITLE_FONT } from "@/lib/chart-geometry";
import type { SummaryPlot } from "@/lib/summary-geometry";
import type { ChartInk } from "./chart-svg";

// A chart of repeats (lib/summary-geometry.ts): bars or boxes with every repeat as a dot, a
// standard curve with its samples, lines with a shaded spread, a dose-response curve or a
// histogram, in screen ink or export ink like ChartSvg.

const CAP = 3;
// The shaded spread: the hue as a light wash, so the line over it stays the mark.
const BAND_OPACITY = 0.16;

export function SummarySvg({ plot, ink, clipId, label, children }: { plot: SummaryPlot; ink: ChartInk; clipId: string; label: string; children?: ReactNode }) {
  const { area } = plot;
  const bottom = area.top + area.height;
  const color = (c: keyof ChartInk["series"] | null) => (c === null ? ink.tick : ink.series[c]);
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
        <line x1={area.left} x2={area.left + area.width} y1={plot.baseline ?? bottom} y2={plot.baseline ?? bottom} stroke={ink.axis} strokeWidth={1} shapeRendering="crispEdges" />
      </g>
      <g fontSize={TICK_FONT} fill={ink.tick}>
        {plot.yTicks.map((t) => (
          <text key={`y${t.label}`} x={area.left - 8} y={t.pos} textAnchor="end" dominantBaseline="middle">
            {t.label}
          </text>
        ))}
        {plot.xTicks.map((t, i) => (
          <text key={`x${i}`} x={t.pos} y={bottom + TICK_FONT + 6} textAnchor="middle">
            {t.lines.map((line, j) => (
              <tspan key={j} x={t.pos} dy={j === 0 ? 0 : TICK_FONT + 2}>
                {line}
              </tspan>
            ))}
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
          <text x={plot.yTitle.x} y={plot.yTitle.y} textAnchor="middle" transform={`rotate(-90 ${plot.yTitle.x} ${plot.yTitle.y})`} fill={plot.yTitle.placeholder ? ink.tick : undefined}>
            {plot.yTitle.text}
          </text>
        )}
      </g>
      <g clipPath={`url(#${clipId})`}>
        {plot.bands.map((b, i) => (
          <path key={`band${i}`} d={b.path} fill={ink.series[b.color]} fillOpacity={BAND_OPACITY} stroke="none" />
        ))}
        {plot.bars.map((b, i) => (
          <path key={`bar${i}`} d={b.path} fill={b.soft ? ink.soft[b.color] : ink.series[b.color]} />
        ))}
        {plot.boxes.map((b, i) => {
          const mid = b.x + b.width / 2;
          const s = ink.series[b.color];
          return (
            <g key={`box${i}`} stroke={s} strokeWidth={1.5} fill="none">
              <path d={`M${mid} ${b.q3}V${b.high}M${mid - b.width / 4} ${b.high}H${mid + b.width / 4}M${mid} ${b.q1}V${b.low}M${mid - b.width / 4} ${b.low}H${mid + b.width / 4}`} />
              <rect x={b.x} y={Math.min(b.q1, b.q3)} width={b.width} height={Math.max(1, Math.abs(b.q1 - b.q3))} rx={3} fill={ink.soft[b.color]} />
              <line x1={b.x} x2={b.x + b.width} y1={b.median} y2={b.median} strokeWidth={2.5} />
            </g>
          );
        })}
        {plot.rules.map((r, i) => (
          <line key={`rule${i}`} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} stroke={color(r.color)} strokeWidth={r.width} strokeDasharray={r.dashed ? "4 3" : undefined} />
        ))}
        {plot.curves.map((c, i) => (
          <path key={`curve${i}`} d={c.path} stroke={ink.series[c.color]} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={c.dashed ? "6 4" : undefined} />
        ))}
        {plot.whiskers.map((w, i) => (
          <path
            key={`w${i}`}
            d={`M${w.px} ${w.top}V${w.bottom}M${w.px - CAP} ${w.top}H${w.px + CAP}M${w.px - CAP} ${w.bottom}H${w.px + CAP}`}
            stroke={ink.label}
            strokeWidth={1.5}
            fill="none"
          />
        ))}
        {plot.hWhiskers.map((w, i) => (
          <path
            key={`hw${i}`}
            d={`M${w.left} ${w.py}H${w.right}M${w.left} ${w.py - CAP}V${w.py + CAP}M${w.right} ${w.py - CAP}V${w.py + CAP}`}
            stroke={ink.series[w.color]}
            strokeWidth={1.5}
            fill="none"
          />
        ))}
        {plot.dots.map((d, i) => {
          const s = ink.series[d.color];
          switch (d.kind) {
            case "repeat":
              return <circle key={`d${i}`} cx={d.px} cy={d.py} r={d.r} fill={s} fillOpacity={0.85} stroke={ink.surface} strokeWidth={1} />;
            case "mean":
              return <circle key={`d${i}`} cx={d.px} cy={d.py} r={d.r} fill={s} stroke={ink.surface} strokeWidth={2} />;
            case "sample":
            case "outside": {
              const r = d.r + 1;
              return (
                <path
                  key={`d${i}`}
                  d={`M${d.px} ${d.py - r}L${d.px + r} ${d.py}L${d.px} ${d.py + r}L${d.px - r} ${d.py}Z`}
                  fill={d.kind === "sample" ? s : ink.surface}
                  stroke={d.kind === "sample" ? ink.surface : s}
                  strokeWidth={d.kind === "sample" ? 1.5 : 2}
                />
              );
            }
            default: {
              const _exhaustive: never = d.kind;
              return _exhaustive;
            }
          }
        })}
      </g>
      <g fill={ink.label}>
        {plot.labels.map((l, i) => (
          <text key={`l${i}`} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={l.size} fontWeight={l.weight} fill={l.ink === "tick" ? ink.tick : ink.label}>
            {l.text}
          </text>
        ))}
      </g>
      {plot.legend.length === 0 ? null : (
        <g fontSize={TICK_FONT} fill={ink.label}>
          {plot.legend.map((item) => {
            const s = ink.series[item.color];
            return (
              <g key={item.name}>
                {item.mark === "line" ? (
                  <line x1={item.x} x2={item.x + 16} y1={item.y} y2={item.y} stroke={s} strokeWidth={2} strokeLinecap="round" />
                ) : item.mark === "sample" ? (
                  <path d={`M${item.x + 8} ${item.y - 5}L${item.x + 13} ${item.y}L${item.x + 8} ${item.y + 5}L${item.x + 3} ${item.y}Z`} fill={s} />
                ) : (
                  <circle cx={item.x + 8} cy={item.y} r={4} fill={s} />
                )}
                <text x={item.x + 22} y={item.y} dominantBaseline="middle">
                  {item.name}
                </text>
              </g>
            );
          })}
        </g>
      )}
      {plot.caption.lines.length === 0 ? null : (
        <g fontSize={plot.caption.size} fill={ink.label}>
          {plot.caption.lines.map((line, i) => (
            <text key={i} x={0} y={plot.caption.y + i * (plot.caption.size + 4)}>
              {line}
            </text>
          ))}
        </g>
      )}
      {children}
    </svg>
  );
}
