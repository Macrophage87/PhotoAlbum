/** Shared gradient header used until a theme ships its own illustration. */
export function PlaceholderArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1200 240" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="ph-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--th-primary)" />
          <stop offset="1" stopColor="var(--th-accent)" />
        </linearGradient>
      </defs>
      <rect width="1200" height="240" fill="url(#ph-grad)" />
      <path d="M0 200 Q300 140 600 200 T1200 200 V240 H0 Z" fill="var(--th-bg)" opacity="0.9" />
    </svg>
  );
}
