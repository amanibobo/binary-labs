import logo from "@/lib/logo.json";

type Cell = { x: number; y: number; fill: "ink" | "green" | "blue" };

// The b drawn in squares: the bottom-left square is green, the one above it blue, the rest ink.
const CELLS: readonly Cell[] = logo.rows.flatMap((row, y) =>
  [...row].flatMap((c, x): Cell[] => {
    if (c !== "X") return [];
    const fill = x === 0 && y === logo.rows.length - 1 ? "green" : x === 0 && y === logo.rows.length - 2 ? "blue" : "ink";
    return [{ x, y, fill }];
  }),
);

const step = logo.cell + logo.gap;
const width = (logo.rows[0]?.length ?? 0) * step - logo.gap;
const height = logo.rows.length * step - logo.gap;

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      {CELLS.map(({ x, y, fill }) => (
        <rect
          key={`${x}-${y}`}
          x={x * step}
          y={y * step}
          width={logo.cell}
          height={logo.cell}
          rx={logo.radius}
          fill={fill === "ink" ? "currentColor" : logo[fill]}
        />
      ))}
    </svg>
  );
}
