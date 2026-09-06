import { ArtFrame } from "./shared";

/** Cypress and mangroves over still water, a heron, and a low sun. */
export function SwampArt({ className }: { className?: string }) {
  return (
    <ArtFrame className={className} id="sw" skyFrom="#e6b27a" skyTo="#f7e3c3">
      <circle cx="300" cy="120" r="46" fill="#e07a2f" opacity="0.9" />
      <path d="M0 150 L40 135 L70 150 L110 128 L150 150 L190 132 L230 150 L270 140 L310 152 L350 130 L390 150 L430 138 L470 152 L510 134 L550 150 L590 140 L630 152 L670 130 L710 150 L750 136 L790 152 L830 132 L870 150 L910 140 L950 152 L990 130 L1030 150 L1070 138 L1110 152 L1150 134 L1200 150 V240 H0 Z" fill="#2f5e3a" />
      <rect x="0" y="176" width="1200" height="64" fill="#5c7f5a" />
      <path d="M0 176 Q300 170 600 178 T1200 176 V240 H0 Z" fill="#4c6f4c" />
      <g fill="#3e2a1c">
        <rect x="120" y="120" width="12" height="70" />
        <path d="M108 190 L144 190 L138 178 L114 178 Z" />
        <rect x="960" y="110" width="14" height="80" />
        <path d="M946 190 L988 190 L982 176 L952 176 Z" />
      </g>
      <g fill="#1f4d2e">
        <ellipse cx="126" cy="110" rx="60" ry="30" />
        <ellipse cx="967" cy="98" rx="70" ry="34" />
      </g>
      <g stroke="#8fb996" strokeWidth="2" fill="none" opacity="0.8">
        <path d="M100 118 q4 20 0 40" /><path d="M150 116 q-4 22 0 44" /><path d="M940 104 q4 24 0 48" /><path d="M1000 106 q-4 20 0 44" />
      </g>
      <g fill="#f4f6f8">
        <ellipse cx="640" cy="170" rx="16" ry="8" />
        <path d="M652 166 q8 -18 6 -34 q6 4 12 2 l-4 6 q-4 2 -8 -2 q0 14 -4 28 Z" />
        <rect x="636" y="176" width="2" height="18" fill="#3e2a1c" /><rect x="644" y="176" width="2" height="18" fill="#3e2a1c" />
      </g>
      <g stroke="#2f5e3a" strokeWidth="3" strokeLinecap="round">
        <path d="M400 236 v-40" /><path d="M412 236 v-30" /><path d="M424 236 v-46" /><path d="M780 236 v-36" /><path d="M792 236 v-48" />
      </g>
      <path d="M0 222 Q200 218 400 224 T800 222 T1200 224 V240 H0 Z" fill="#e6b27a" opacity="0.25" />
    </ArtFrame>
  );
}

export const swampMarker =
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#1f4d2e" stroke="#fff" stroke-width="2.5"/><ellipse cx="17" cy="21" rx="7" ry="4" fill="#f4f6f8"/><path d="M22 19 q3 -8 2 -12 q3 2 5 1 l-2 3 q-2 1 -3 -1 q0 6 -1 9 Z" fill="#f4f6f8"/><rect x="14" y="24" width="1.5" height="5" fill="#f4f6f8"/><rect x="19" y="24" width="1.5" height="5" fill="#f4f6f8"/></svg>';
export const swampMotif =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="16" viewBox="0 0 40 16"><path d="M0 12 q10 -8 20 0 t20 0" fill="none" stroke="#1f4d2e" stroke-width="1.5"/></svg>');
