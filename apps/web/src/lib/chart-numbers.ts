import { SPREAD_NAMES, TEST_NAMES, type Analysis, type GroupStat } from "./analysis";
import type { HistogramSpec, SummarySpec } from "./charts";

// The numbers behind a chart of repeats, as tables: each group's n, mean, SD, SEM and 95% CI
// (whichever the bars show), the test, the fit's parameters, the samples read off a curve and a
// histogram's bins. "Show the numbers" draws them; the CSV download writes them, unrounded, so
// a reader can check every value the chart shows.

export type NumberTable = { title: string; columns: string[]; rows: (string | number | null)[][] };

function groupRows(groups: readonly GroupStat[], key: string, unit: string): NumberTable {
  return {
    title: "Groups",
    columns: [key, unit ? `${key === "Group" ? "At" : key} (${unit})` : "At", "n", "Mean", "SD", "SEM", "95% CI ±", "95% CI low", "95% CI high", "Repeats"],
    rows: groups.map((g) => [
      g.label,
      g.at,
      g.summary.n,
      g.summary.n > 0 ? g.summary.mean : null,
      g.summary.sd,
      g.summary.sem,
      g.summary.ci,
      g.summary.ci === null ? null : g.summary.mean - g.summary.ci,
      g.summary.ci === null ? null : g.summary.mean + g.summary.ci,
      g.repeats.map((r) => `${r.where}: ${r.value}`).join("; "),
    ]),
  };
}

export function chartNumbers(spec: SummarySpec | HistogramSpec, a: Analysis): NumberTable[] {
  const out: NumberTable[] = [];
  const about: (string | number | null)[][] = [];
  if (spec.type !== "histogram") about.push(["Error bars", SPREAD_NAMES[spec.spread]]);
  switch (a.kind) {
    case "groups": {
      if (a.blank !== null) about.push(["Blank subtracted", a.blank.mean], ["Blank wells", a.blank.n]);
      out.push(groupRows(a.groups, "Group", ""));
      const t = a.test;
      if (t.kind === "welch") {
        out.push({
          title: "Test",
          columns: ["Test", "Groups", "t", "df", "p", "n"],
          rows: [[TEST_NAMES.welch, `${t.a.label} vs ${t.b.label}`, t.result.statistic, t.result.df, t.result.p, `${t.a.summary.n}, ${t.b.summary.n}`]],
        });
      } else if (t.kind === "anova") {
        out.push({ title: "Test", columns: ["Test", "F", "df between", "df within", "p"], rows: [[TEST_NAMES.anova, t.result.statistic, t.result.df, t.result.df2, t.result.p]] });
      } else if (t.kind === "control") {
        out.push({
          title: "Test",
          columns: ["Test", "Group", "Against", "n", "p", "p, Holm-corrected"],
          rows: t.comparisons.map((c) => ["Welch's t-test", c.label, t.control.label, c.n, c.p, c.adjusted]),
        });
      } else if (t.kind === "cannot") {
        about.push(["Test", `${TEST_NAMES[t.test]} can't run: ${t.reason}`]);
      }
      if (spec.type === "groups" && spec.mark === "box") {
        out.push({
          title: "Boxes (quartiles by linear interpolation, whiskers to 1.5 × IQR)",
          columns: ["Group", "Q1", "Median", "Q3", "Whisker low", "Whisker high", "Outliers"],
          rows: a.groups.map((g, i) => {
            const b = a.boxes[i];
            return b === null || b === undefined ? [g.label, null, null, null, null, null, ""] : [g.label, b.q1, b.median, b.q3, b.low, b.high, b.outliers.join("; ")];
          }),
        });
      }
      break;
    }
    case "curve": {
      if (a.blank !== null) about.push(["Blank subtracted", a.blank.mean], ["Blank wells", a.blank.n]);
      out.push(groupRows(a.standards, "Standard", a.grouped.key.unit));
      if (a.fit !== null) {
        out.push({ title: "Fit", columns: ["Line", "Slope", "Intercept", "R²", "Points"], rows: [[a.fit.origin ? "Through the origin" : "Least squares", a.fit.slope, a.fit.intercept, a.fit.r2, a.fit.n]] });
      }
      if (a.unknowns.length > 0) {
        const u = a.grouped.key.unit ? ` (${a.grouped.key.unit})` : "";
        out.push({
          title: "Samples",
          columns: ["Sample", "n", "Mean reading", `In the well${u}`, "Dilution", `In the sample${u}`, "Within the standards"],
          rows: a.unknowns.map((k) => [k.label, k.n, k.reading, k.conc, k.dilution, k.original, k.outside === null ? "yes" : `no, ${k.outside}`]),
        });
      }
      break;
    }
    case "band":
      for (const s of a.series) out.push({ ...groupRows(s.groups, "Point", a.grouped.key.unit), title: s.name });
      break;
    case "dose": {
      if (a.blank !== null) about.push(["Blank subtracted", a.blank.mean], ["Blank wells", a.blank.n]);
      const controls = [...new Set(a.series.map((s) => s.control).filter((c): c is GroupStat => c !== null))];
      out.push(groupRows([...controls, ...a.series.flatMap((s) => s.doses)], "Group", a.unit));
      out.push({
        title: "Four-parameter fit (log10 of the dose)",
        columns: ["Series", "Result", "IC50 or EC50", "95% CI low", "95% CI high", "Top", "Bottom", "Hill slope", "log10 midpoint", "SE of log10 midpoint", "Points", "df", "Why"],
        rows: a.series.map((s) => {
          const fit = s.fit.kind === "fit" ? s.fit : null;
          const v = s.verdict;
          return [
            s.name,
            v.kind === "ok" ? s.term : v.kind === "unsure" ? `${s.term} not pinned down` : "no curve",
            v.kind === "ok" ? v.mid : null,
            v.kind === "ok" ? v.ci[0] : null,
            v.kind === "ok" ? v.ci[1] : null,
            s.params?.top ?? null,
            s.params?.bottom ?? null,
            s.params?.hill ?? null,
            s.params?.logMid ?? null,
            fit?.se?.logMid ?? null,
            fit?.n ?? null,
            fit?.df ?? null,
            v.kind === "ok" ? "" : v.reason,
          ];
        }),
      });
      break;
    }
    case "histogram":
      about.push(["Bins", a.rule]);
      out.push({ title: "Bins", columns: ["From", "Up to", "Count"], rows: a.counts.map((c, i) => [a.edges[i], a.edges[i + 1], c]) });
      break;
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
  return about.length === 0 ? out : [{ title: "About", columns: ["", ""], rows: about }, ...out];
}

function cell(v: string | number | null): string {
  if (v === null) return "";
  const text = typeof v === "number" ? String(v) : v;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The tables as one CSV, each under its title.
export function numbersCsv(tables: readonly NumberTable[], heading: readonly string[]): string {
  const lines: string[] = heading.map((h) => cell(h));
  for (const t of tables) {
    lines.push("", cell(t.title), t.columns.map(cell).join(","));
    for (const r of t.rows) lines.push(r.map(cell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
