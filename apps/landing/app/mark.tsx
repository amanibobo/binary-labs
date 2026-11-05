// The Binary Labs mark from the favicon: a tall bar and a dot. In motion the dot is an eye that
// looks around and blinks.
export function Mark({ className, animated = true }: { className?: string; animated?: boolean }) {
  return (
    <svg viewBox="6 6 20 20" aria-hidden focusable="false" className={className} overflow="visible">
      <g className={animated ? "mark-face" : undefined}>
        <rect x="9" y="9" width="5" height="14" rx="1.5" fill="currentColor" />
        <g className={animated ? "mark-look" : undefined}>
          <rect className="mark-dot" x="18" y="9" width="5" height="5" rx="1.5" fill="currentColor" />
        </g>
      </g>
    </svg>
  );
}
