import { ArtFrame } from "./shared";

/** Jagged snow-capped peaks, a pine line and a cold lake. */
export function AlpineArt({ className }: { className?: string }) {
  const pines = [40, 90, 140, 560, 610, 660, 1080, 1130, 1170];
  return (
    <ArtFrame className={className} id="al" skyFrom="#1f5f8b" skyTo="#dbeaf5">
      <circle cx="220" cy="60" r="28" fill="#fff" opacity="0.8" />
      <path d="M0 175 L120 95 L200 150 L300 70 L400 160 L500 100 L600 165 L700 80 L820 160 L920 90 L1020 165 L1120 110 L1200 150 V240 H0 Z" fill="#6f8aa3" />
      <g fill="#ffffff">
        <path d="M300 70 L275 105 L295 98 L310 110 L325 100 L340 108 Z" />
        <path d="M700 80 L672 118 L695 110 L708 122 L724 112 L740 120 Z" />
        <path d="M920 90 L896 124 L916 118 L930 128 L946 118 L960 126 Z" />
      </g>
      <path d="M0 200 L150 140 L260 190 L380 120 L520 195 L640 140 L760 195 L900 130 L1040 195 L1200 150 V240 H0 Z" fill="#3f5c73" />
      <g fill="#ffffff" opacity="0.95">
        <path d="M380 120 L360 148 L378 142 L390 152 L404 142 L418 150 Z" />
        <path d="M900 130 L878 160 L897 154 L910 164 L925 153 L940 162 Z" />
      </g>
      <g fill="#2f6b3a">
        {pines.map((x) => (
          <path key={x} d={`M${x} 236 L${x + 14} 190 L${x + 28} 236 Z M${x + 3} 218 L${x + 14} 178 L${x + 25} 218 Z`} />
        ))}
      </g>
      <path d="M300 236 Q520 214 760 236 Z" fill="#8fc0e0" opacity="0.9" />
      <path d="M0 232 H1200 V240 H0 Z" fill="#e6eef4" />
    </ArtFrame>
  );
}

export const alpineMarker =
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#1f5f8b" stroke="#fff" stroke-width="2.5"/><path d="M8 26 L16 12 L20 18 L23 14 L29 26 Z" fill="#e6eef4"/><path d="M16 12 L13.5 16.5 L16 15 L18 17.5 L20 18 Z" fill="#fff"/></svg>';
export const alpineMotif =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="14" viewBox="0 0 36 14"><path d="M0 12 L9 2 L18 12 L27 2 L36 12" fill="none" stroke="#1f5f8b" stroke-width="1.5"/></svg>');
