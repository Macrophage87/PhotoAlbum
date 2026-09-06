import { ArtFrame } from "./shared";

/** Misty rolling hills, a loch, and a castle keep on the ridge. */
export function HighlandsArt({ className }: { className?: string }) {
  return (
    <ArtFrame className={className} id="hl" skyFrom="#3d2a52" skyTo="#b7a3cf">
      <circle cx="240" cy="70" r="30" fill="#fff7ea" opacity="0.75" />
      <path d="M0 150 Q150 90 300 140 T600 130 T900 150 T1200 120 V240 H0 Z" fill="#6b5a86" opacity="0.8" />
      <path d="M0 175 Q200 120 400 165 T800 160 T1200 170 V240 H0 Z" fill="#5e3a7a" opacity="0.85" />
      <g fill="#2b1d33">
        <rect x="820" y="120" width="70" height="46" />
        <rect x="812" y="108" width="20" height="58" />
        <rect x="878" y="102" width="22" height="64" />
        <path d="M812 108 h5 v-6 h5 v6 h5 v-6 h5 v6 M878 102 h5 v-6 h6 v6 h6 v-6 h5 v6" />
        <rect x="846" y="140" width="10" height="16" fill="#e9c77b" />
      </g>
      <path d="M0 200 Q250 150 500 195 T1000 190 T1200 205 V240 H0 Z" fill="#4f7a3a" />
      <path d="M0 215 Q300 180 600 215 T1200 210 V240 H0 Z" fill="#3d6130" />
      <g fill="#a678c8" opacity="0.7">
        <circle cx="140" cy="205" r="4" /><circle cx="160" cy="212" r="3" /><circle cx="120" cy="214" r="3" />
        <circle cx="1040" cy="206" r="4" /><circle cx="1062" cy="213" r="3" /><circle cx="1020" cy="215" r="3" />
        <circle cx="620" cy="220" r="3" /><circle cx="640" cy="226" r="3" />
      </g>
      <path d="M380 232 Q560 210 760 232 Z" fill="#6f8fb0" opacity="0.8" />
      <rect x="0" y="180" width="1200" height="60" fill="#ffffff" opacity="0.12" />
    </ArtFrame>
  );
}

export const highlandsMarker =
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#5e3a7a" stroke="#fff" stroke-width="2.5"/><path d="M18 27 V16" stroke="#cbe3b0" stroke-width="2.5" stroke-linecap="round"/><ellipse cx="18" cy="13" rx="5" ry="6" fill="#c9a0e0"/><path d="M13 13 q-3 4 0 8 M23 13 q3 4 0 8" stroke="#cbe3b0" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
export const highlandsMotif =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" fill="#5e3a7a" opacity="0.08"/><rect x="0" y="10" width="24" height="4" fill="#4f7a3a" opacity="0.25"/><rect x="10" y="0" width="4" height="24" fill="#4f7a3a" opacity="0.25"/></svg>');
