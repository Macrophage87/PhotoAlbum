import { ArtFrame } from "./shared";

export function DefaultArt({ className }: { className?: string }) {
  return (
    <ArtFrame className={className} id="def">
      <circle cx="980" cy="70" r="34" fill="#fff" opacity="0.9" />
      <path d="M0 190 Q200 150 400 185 T800 180 T1200 188 V240 H0 Z" fill="#fff" opacity="0.18" />
      <path d="M0 205 Q300 175 600 205 T1200 200 V240 H0 Z" fill="var(--th-bg)" />
    </ArtFrame>
  );
}
