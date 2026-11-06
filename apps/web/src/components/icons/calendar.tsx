import { Svg, type IconProps } from "./svg";

const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" } as const;

// A page of a desk calendar with its two rings, drawn like the other sidebar icons.
export function CalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect {...line} x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path {...line} d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </Svg>
  );
}
