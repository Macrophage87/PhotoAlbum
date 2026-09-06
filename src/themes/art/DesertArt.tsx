import { ArtFrame } from "./shared";

/** Layered mesas, a saguaro, and a big turquoise sky. */
export function DesertArt({ className }: { className?: string }) {
  return (
    <ArtFrame className={className} id="ds" skyFrom="#2aa1a8" skyTo="#f6d7a8">
      <circle cx="1000" cy="90" r="40" fill="#ffe9b0" opacity="0.95" />
      <path d="M0 160 L120 160 L150 120 L330 120 L360 160 L520 160 L560 135 L700 135 L730 160 L1200 160 V240 H0 Z" fill="#c98763" opacity="0.7" />
      <path d="M0 185 L200 185 L230 150 L420 150 L450 185 L800 185 L830 155 L960 155 L990 185 L1200 185 V240 H0 Z" fill="#b5542a" />
      <path d="M230 150 L420 150 L450 185 L200 185 Z" fill="#9c4520" opacity="0.5" />
      <g stroke="#8a3d1c" strokeWidth="2" opacity="0.5">
        <path d="M205 172 H445" /><path d="M835 170 H985" />
      </g>
      <path d="M0 210 Q300 200 600 212 T1200 208 V240 H0 Z" fill="#e3b58a" />
      <g fill="#4f7a3a">
        <rect x="150" y="120" width="18" height="110" rx="9" />
        <rect x="120" y="140" width="14" height="40" rx="7" />
        <rect x="120" y="170" width="36" height="12" rx="6" />
        <rect x="176" y="125" width="14" height="46" rx="7" />
        <rect x="160" y="160" width="30" height="12" rx="6" />
      </g>
      <g fill="#8aa07a">
        <ellipse cx="700" cy="222" rx="22" ry="9" /><ellipse cx="740" cy="226" rx="16" ry="7" /><ellipse cx="1100" cy="220" rx="24" ry="10" />
      </g>
    </ArtFrame>
  );
}

export const desertMarker =
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#b5542a" stroke="#fff" stroke-width="2.5"/><rect x="16" y="9" width="4.5" height="19" rx="2.2" fill="#dfe8c8"/><rect x="10" y="13" width="3.5" height="8" rx="1.7" fill="#dfe8c8"/><rect x="10" y="19" width="8" height="3" rx="1.5" fill="#dfe8c8"/><rect x="23" y="11" width="3.5" height="9" rx="1.7" fill="#dfe8c8"/><rect x="19" y="18" width="7.5" height="3" rx="1.5" fill="#dfe8c8"/></svg>';
export const desertMotif =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="12" viewBox="0 0 32 12"><path d="M0 10 L8 2 L16 10 L24 2 L32 10" fill="none" stroke="#b5542a" stroke-width="1.5"/></svg>');
