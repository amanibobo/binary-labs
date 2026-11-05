// The square b, kept in step with apps/web/src/lib/logo.json: bottom-left green, the one above it blue.
const ROWS = ["X...", "X...", "XXX.", "X..X", "X..X", "XXX."] as const;
const CELL = 10;
const GAP = 1.5;
const STEP = CELL + GAP;
const WIDTH = 4 * STEP - GAP;
const HEIGHT = ROWS.length * STEP - GAP;

const CELLS = ROWS.flatMap((row, y) =>
  [...row].flatMap((c, x) => {
    if (c !== "X") return [];
    const fill = x === 0 && y === ROWS.length - 1 ? "#1F9D6B" : x === 0 && y === ROWS.length - 2 ? "#2F7FE0" : "currentColor";
    return [{ x, y, fill }];
  }),
);

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className={className} role="img" aria-label="Binary Labs">
      {CELLS.map(({ x, y, fill }) => (
        <rect key={`${x}-${y}`} x={x * STEP} y={y * STEP} width={CELL} height={CELL} rx={1.6} fill={fill} />
      ))}
    </svg>
  );
}
