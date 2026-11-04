const BODY =
  "M120 204 L126 322 C132 392 176 480 192 502 Q200 514 208 502 C224 480 268 392 274 322 L280 204 Z";
const WALL =
  "M140 214 L145 322 C151 386 185 464 196 484 Q200 491 204 484 C215 464 249 386 255 322 L260 214 Z";

export function Tube() {
  return (
    <svg
      viewBox="0 0 400 540"
      role="img"
      aria-label="A translucent amber sample tube with its cap open"
      className="h-auto w-full"
    >
      <defs>
        <linearGradient id="tube-body" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#ffe066" />
          <stop offset="0.45" stopColor="#ffcf33" />
          <stop offset="0.85" stopColor="#f7ac1f" />
          <stop offset="1" stopColor="#ec8a14" />
        </linearGradient>
        <linearGradient id="tube-wall" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#e7951a" stopOpacity="0.55" />
          <stop offset="1" stopColor="#d87810" stopOpacity="0.75" />
        </linearGradient>
        <linearGradient id="tube-liquid" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#e58a14" stopOpacity="0.8" />
          <stop offset="1" stopColor="#c8660a" stopOpacity="0.95" />
        </linearGradient>
        <linearGradient id="tube-rim" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffe680" />
          <stop offset="1" stopColor="#f3a81d" />
        </linearGradient>
        <linearGradient id="tube-cap" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#ffe066" />
          <stop offset="1" stopColor="#ef9a18" />
        </linearGradient>
        <radialGradient id="tube-glow" cx="0.32" cy="0.25" r="0.7">
          <stop offset="0" stopColor="#fff6c8" stopOpacity="0.75" />
          <stop offset="1" stopColor="#fff6c8" stopOpacity="0" />
        </radialGradient>
        <filter id="tube-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <clipPath id="tube-inside">
          <path d={WALL} />
        </clipPath>
      </defs>

      <path
        d="M112 194 C88 184 72 164 66 142"
        fill="none"
        stroke="url(#tube-rim)"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <g transform="rotate(-32 62 108)">
        <rect x="8" y="82" width="110" height="48" rx="20" fill="url(#tube-cap)" />
        <rect x="26" y="124" width="74" height="22" rx="10" fill="#e48c14" opacity="0.8" />
        <rect x="22" y="90" width="64" height="8" rx="4" fill="#fff" opacity="0.55" filter="url(#tube-soft)" />
      </g>

      <path d={BODY} fill="url(#tube-body)" />
      <path d={WALL} fill="url(#tube-wall)" filter="url(#tube-soft)" />
      <g clipPath="url(#tube-inside)">
        <rect x="120" y="360" width="160" height="160" fill="url(#tube-liquid)" />
        <ellipse cx="200" cy="360" rx="64" ry="8" fill="#f6b638" opacity="0.9" />
      </g>
      <path d={BODY} fill="url(#tube-glow)" />
      <path
        d="M132 222 L136 322 C140 372 160 424 176 458"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.7"
        strokeWidth="9"
        strokeLinecap="round"
        filter="url(#tube-soft)"
      />
      <g stroke="#b85f0a" strokeOpacity="0.35" strokeWidth="2.5" strokeLinecap="round">
        <path d="M240 252 H256" />
        <path d="M244 292 H256" />
        <path d="M240 332 H254" />
      </g>

      <rect x="104" y="166" width="192" height="44" rx="20" fill="url(#tube-rim)" />
      <ellipse cx="200" cy="172" rx="84" ry="11" fill="#e08a12" opacity="0.5" />
      <rect x="122" y="192" width="86" height="7" rx="3.5" fill="#fff" opacity="0.65" filter="url(#tube-soft)" />
    </svg>
  );
}
