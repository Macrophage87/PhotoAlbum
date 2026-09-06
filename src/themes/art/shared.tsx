import type { ReactNode } from "react";

/** Common frame: 1200x240 viewBox, stretched to the header width; sky gradient from the given colours. */
export function ArtFrame({ className, children, skyFrom = "var(--th-primary)", skyTo = "var(--th-accent)", id }: { className?: string; children: ReactNode; skyFrom?: string; skyTo?: string; id: string }) {
  return (
    <svg className={className} viewBox="0 0 1200 240" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={skyFrom} />
          <stop offset="1" stopColor={skyTo} />
        </linearGradient>
      </defs>
      <rect width="1200" height="240" fill={`url(#${id}-sky)`} />
      {children}
    </svg>
  );
}
