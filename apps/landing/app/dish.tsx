const CX = 240;
const TOP = 176;
const DEPTH = 46;
const RX = 196;
const RY = 78;

// Colonies sit on the agar; ry is squashed to match the dish's perspective.
const COLONIES = [
  { x: 168, y: 190, r: 15, tone: "cream" },
  { x: 206, y: 214, r: 9, tone: "cream" },
  { x: 286, y: 178, r: 21, tone: "cream" },
  { x: 318, y: 214, r: 11, tone: "deep" },
  { x: 246, y: 236, r: 13, tone: "cream" },
  { x: 136, y: 222, r: 8, tone: "deep" },
  { x: 352, y: 192, r: 7, tone: "cream" },
  { x: 230, y: 168, r: 6, tone: "deep" },
] as const;

const wall = `M${CX - RX} ${TOP} L${CX - RX} ${TOP + DEPTH} A${RX} ${RY} 0 0 0 ${CX + RX} ${TOP + DEPTH} L${CX + RX} ${TOP} A${RX} ${RY} 0 0 1 ${CX - RX} ${TOP} Z`;

export function Dish() {
  return (
    <svg viewBox="0 0 480 330" role="img" aria-label="A glossy amber petri dish with a few colonies growing on it" className="h-auto w-full">
      <defs>
        <linearGradient id="dish-wall" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#ef8f13" />
          <stop offset="0.18" stopColor="#ffcf3a" />
          <stop offset="0.55" stopColor="#ffd84f" />
          <stop offset="0.88" stopColor="#f6a91c" />
          <stop offset="1" stopColor="#e47c0d" />
        </linearGradient>
        <linearGradient id="dish-rim" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffe98f" />
          <stop offset="1" stopColor="#ffc93a" />
        </linearGradient>
        <linearGradient id="dish-inner" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#e8901a" />
          <stop offset="1" stopColor="#f6b52c" />
        </linearGradient>
        <radialGradient id="dish-agar" cx="0.45" cy="0.42" r="0.62">
          <stop offset="0" stopColor="#ffd25a" />
          <stop offset="0.7" stopColor="#f4ad2a" />
          <stop offset="1" stopColor="#e2901b" />
        </radialGradient>
        <radialGradient id="colony-cream" cx="0.38" cy="0.32" r="0.7">
          <stop offset="0" stopColor="#fffaf0" />
          <stop offset="1" stopColor="#ffe3a1" />
        </radialGradient>
        <radialGradient id="colony-deep" cx="0.38" cy="0.32" r="0.7">
          <stop offset="0" stopColor="#f39a2c" />
          <stop offset="1" stopColor="#c9640c" />
        </radialGradient>
        <filter id="dish-blur-sm" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
        <clipPath id="dish-wall-clip">
          <path d={wall} />
        </clipPath>
        <filter id="dish-blur-lg" x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>

      <ellipse cx={CX} cy={TOP + DEPTH + 30} rx={RX - 24} ry={26} fill="#000" opacity="0.07" filter="url(#dish-blur-lg)" />

      <path d={wall} fill="url(#dish-wall)" />
      <path
        clipPath="url(#dish-wall-clip)"
        d={`M${CX - RX + 6} ${TOP + 22} A${RX - 6} ${RY - 4} 0 0 0 ${CX + RX - 6} ${TOP + 22}`}
        fill="none"
        stroke="#d97a0e"
        strokeOpacity="0.45"
        strokeWidth="14"
        filter="url(#dish-blur-sm)"
      />
      <ellipse cx={CX} cy={TOP} rx={RX} ry={RY} fill="url(#dish-rim)" />
      <ellipse cx={CX} cy={TOP + 3} rx={RX - 11} ry={RY - 8} fill="url(#dish-inner)" />
      <ellipse cx={CX} cy={TOP + 16} rx={RX - 24} ry={RY - 20} fill="url(#dish-agar)" filter="url(#dish-blur-sm)" />

      {COLONIES.map((c) => (
        <g key={`${c.x}-${c.y}`}>
          <ellipse cx={c.x} cy={c.y + c.r * 0.22} rx={c.r} ry={c.r * 0.42} fill="#b85a08" opacity="0.18" filter="url(#dish-blur-sm)" />
          <ellipse cx={c.x} cy={c.y} rx={c.r} ry={c.r * 0.45} fill={`url(#colony-${c.tone})`} />
        </g>
      ))}

      <ellipse cx={CX - 40} cy={TOP + 2} rx={110} ry={22} fill="#fff" opacity="0.22" filter="url(#dish-blur-lg)" />
      <path
        d={`M${CX - RX + 18} ${TOP - 18} A${RX - 8} ${RY - 6} 0 0 1 ${CX - 30} ${TOP - RY + 6}`}
        fill="none"
        stroke="#fff"
        strokeOpacity="0.75"
        strokeWidth="5"
        strokeLinecap="round"
        filter="url(#dish-blur-sm)"
      />
      <path
        d={`M${CX - RX + 26} ${TOP + 34} A${RX} ${RY} 0 0 0 ${CX - 60} ${TOP + RY + 30}`}
        fill="none"
        stroke="#fff"
        strokeOpacity="0.55"
        strokeWidth="6"
        strokeLinecap="round"
        filter="url(#dish-blur-sm)"
      />
    </svg>
  );
}
