import { ArtFrame } from "./shared";

/** A dog park at golden hour: a meadow, a picket fence, a couple of trees, a dog mid-fetch and a thrown ball. */
export function KennelArt({ className }: { className?: string }) {
  return (
    <ArtFrame className={className} id="kn" skyFrom="#f6d7a8" skyTo="#fff4e0">
      <circle cx="960" cy="90" r="40" fill="#f2a541" opacity="0.85" />
      {/* far hills */}
      <path d="M0 150 Q150 110 300 140 T600 138 T900 142 T1200 132 V240 H0 Z" fill="#a9c49a" />
      {/* meadow */}
      <path d="M0 176 Q300 162 600 174 T1200 170 V240 H0 Z" fill="#7fa86b" />
      <rect x="0" y="206" width="1200" height="34" fill="#6d9a5c" />
      {/* trees */}
      <g>
        <rect x="150" y="128" width="12" height="60" fill="#6b4a2b" />
        <circle cx="156" cy="112" r="34" fill="#4f7d3f" /><circle cx="134" cy="126" r="24" fill="#5c8c4a" /><circle cx="180" cy="124" r="26" fill="#5c8c4a" />
        <rect x="1030" y="120" width="14" height="70" fill="#6b4a2b" />
        <circle cx="1037" cy="104" r="38" fill="#4f7d3f" /><circle cx="1010" cy="120" r="26" fill="#5c8c4a" /><circle cx="1064" cy="118" r="28" fill="#5c8c4a" />
      </g>
      {/* picket fence */}
      <g fill="#fbf6ea" stroke="#d9c9a8" strokeWidth="1">
        {Array.from({ length: 13 }, (_, i) => (
          <path key={i} d={`M${330 + i * 44} 196 v-30 l6 -8 l6 8 v30 Z`} />
        ))}
        <rect x="326" y="174" width="560" height="5" /><rect x="326" y="188" width="560" height="5" />
      </g>
      {/* dog: a running retriever, side view */}
      <g fill="#c58b45">
        <ellipse cx="640" cy="192" rx="42" ry="18" />
        <path d="M672 182 q26 -14 34 -2 q6 8 -4 14 q-10 8 -22 2 Z" />
        <circle cx="697" cy="184" r="12" />
        <path d="M704 176 q10 -6 12 2 q-2 8 -12 6 Z" fill="#a9733a" />
        <path d="M598 190 q-30 -20 -34 -4 q6 8 26 12 Z" />
        <path d="M614 206 l-10 24 h8 l8 -22 Z" /><path d="M632 208 l-4 22 h8 l2 -22 Z" /><path d="M654 206 l8 24 h8 l-8 -24 Z" /><path d="M668 204 l14 22 h8 l-12 -24 Z" />
      </g>
      <circle cx="702" cy="182" r="2" fill="#2b1d12" /><circle cx="710" cy="188" r="2.5" fill="#2b1d12" />
      <path d="M708 194 q4 4 8 0" stroke="#2b1d12" strokeWidth="1.5" fill="none" />
      {/* tennis ball in flight */}
      <circle cx="820" cy="128" r="9" fill="#d5e04a" />
      <path d="M814 122 q6 6 12 12" stroke="#fff" strokeWidth="1.5" fill="none" />
      <path d="M760 150 q30 -30 60 -22" stroke="#ffffff" strokeWidth="1.5" fill="none" opacity="0.6" strokeDasharray="4 4" />
      {/* paw prints along the path */}
      <g fill="#5e7c4f" opacity="0.7">
        {[[420, 214], [470, 220], [520, 214], [570, 220]].map(([x, y], i) => (
          <g key={i}>
            <ellipse cx={x} cy={y} rx="6" ry="5" />
            <circle cx={x - 6} cy={y - 7} r="2.2" /><circle cx={x - 2} cy={y - 9} r="2.2" /><circle cx={x + 3} cy={y - 9} r="2.2" /><circle cx={x + 7} cy={y - 7} r="2.2" />
          </g>
        ))}
      </g>
    </ArtFrame>
  );
}

export const kennelMarker =
  '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="#8a5a2b" stroke="#fff" stroke-width="2.5"/><ellipse cx="18" cy="22" rx="6" ry="5" fill="#fff4e0"/><circle cx="11" cy="15" r="2.6" fill="#fff4e0"/><circle cx="15.5" cy="12" r="2.6" fill="#fff4e0"/><circle cx="20.5" cy="12" r="2.6" fill="#fff4e0"/><circle cx="25" cy="15" r="2.6" fill="#fff4e0"/></svg>';
export const kennelMotif =
  "data:image/svg+xml;utf8," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="16" viewBox="0 0 44 16"><ellipse cx="12" cy="11" rx="3.2" ry="2.6" fill="#8a5a2b"/><circle cx="8.5" cy="6.5" r="1.4" fill="#8a5a2b"/><circle cx="11" cy="5" r="1.4" fill="#8a5a2b"/><circle cx="13.5" cy="5" r="1.4" fill="#8a5a2b"/><circle cx="16" cy="6.5" r="1.4" fill="#8a5a2b"/><ellipse cx="34" cy="7" rx="3.2" ry="2.6" fill="#8a5a2b"/><circle cx="30.5" cy="2.5" r="1.4" fill="#8a5a2b"/><circle cx="33" cy="1" r="1.4" fill="#8a5a2b"/><circle cx="35.5" cy="1" r="1.4" fill="#8a5a2b"/><circle cx="38" cy="2.5" r="1.4" fill="#8a5a2b"/></svg>');
