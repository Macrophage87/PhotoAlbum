import { ArtFrame } from "./shared";

/** Rocky point, striped lighthouse, gulls and rolling surf. */
export function LighthouseArt({ className }: { className?: string }) {
  return (
    <ArtFrame className={className} id="lh" skyFrom="#0b1a3a" skyTo="#7fa7cf">
      <circle cx="930" cy="80" r="60" fill="#fff" opacity="0.08" />
      <circle cx="930" cy="80" r="26" fill="#fff6d5" opacity="0.9" />
      <g stroke="#ffffff" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity="0.85">
        <path d="M300 70 q10 -10 20 0 q10 -10 20 0" />
        <path d="M350 95 q8 -8 16 0 q8 -8 16 0" />
        <path d="M250 105 q8 -8 16 0 q8 -8 16 0" />
      </g>
      <rect x="0" y="150" width="1200" height="90" fill="#1f4f80" />
      <path d="M735 62 L1200 20 L1200 110 Z" fill="#fff6d5" opacity="0.18" />
      <path d="M560 240 L600 190 L660 200 L700 170 L760 178 L820 160 L880 190 L930 200 L980 240 Z" fill="#2a2f3a" />
      <path d="M600 240 L640 205 L700 210 L760 195 L820 205 L870 240 Z" fill="#3b4353" />
      <g>
        <path d="M708 178 L722 60 L748 60 L762 178 Z" fill="#f4f6f8" />
        <path d="M711 155 L759 155 L757 135 L713 135 Z" fill="#c1272d" />
        <path d="M715 112 L755 112 L753 92 L717 92 Z" fill="#c1272d" />
        <rect x="716" y="44" width="38" height="18" rx="2" fill="#14213d" />
        <rect x="722" y="48" width="26" height="10" fill="#fff6d5" />
        <path d="M712 44 L735 28 L758 44 Z" fill="#14213d" />
        <rect x="704" y="176" width="62" height="8" fill="#e5e7eb" />
        <rect x="732" y="128" width="6" height="8" fill="#14213d" />
        <rect x="732" y="100" width="6" height="8" fill="#14213d" />
      </g>
      <path d="M0 200 Q60 185 120 200 T240 200 T360 200 T480 200 T600 200 T720 200 T840 200 T960 200 T1080 200 T1200 200 V240 H0 Z" fill="#2d6aa3" />
      <path d="M0 215 Q60 202 120 215 T240 215 T360 215 T480 215 T600 215 T720 215 T840 215 T960 215 T1080 215 T1200 215 V240 H0 Z" fill="#4a86bd" opacity="0.9" />
      <path d="M0 228 Q60 218 120 228 T240 228 T360 228 T480 228 T600 228 T720 228 T840 228 T960 228 T1080 228 T1200 228 V240 H0 Z" fill="#dbe7f3" />
    </ArtFrame>
  );
}

export const lighthouseMarker =
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#14213d" stroke="#fff" stroke-width="2.5"/><path d="M14 27 L15.5 11 H20.5 L22 27 Z" fill="#f4f6f8"/><rect x="15" y="16" width="6" height="3" fill="#c1272d"/><rect x="14.6" y="21" width="6.8" height="3" fill="#c1272d"/><rect x="14.5" y="8" width="7" height="3.5" rx="1" fill="#fff6d5"/></svg>';
export const lighthouseMotif =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="12" viewBox="0 0 48 12"><path d="M0 8 Q12 0 24 8 T48 8" fill="none" stroke="#14213d" stroke-width="1.5"/></svg>');
