// Numbers as charts print them, shared by the geometry, the statistics and the words.

const sig = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 5 });

// A value as the tooltip and table show it.
export function formatValue(v: number): string {
  if (v !== 0 && Math.abs(v) < 1e-4) return v.toExponential(2);
  return sig.format(v);
}

const fixedSig = (digits: number) => new Intl.NumberFormat("en-US", { maximumSignificantDigits: digits, minimumSignificantDigits: digits });
const three = fixedSig(3);

// A fitted or summarized number to 3 significant figures: "2.65", "0.0614", "1,250".
export function formatFit(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const text = v !== 0 && (Math.abs(v) < 1e-6 || Math.abs(v) >= 1e9) ? v.toExponential(2) : three.format(v);
  // A typeset minus, as a figure prints it.
  return text.replace(/^-/, "−");
}

// A p-value as papers print it: "0.003", "0.042", "< 0.0001".
export function formatP(p: number): string {
  if (p < 0.0001) return "< 0.0001";
  if (p < 0.001) return p.toFixed(4);
  if (p < 0.01) return p.toFixed(3);
  return p.toFixed(p < 0.995 ? 2 : 3).replace(/^1\.00$/, "1");
}
