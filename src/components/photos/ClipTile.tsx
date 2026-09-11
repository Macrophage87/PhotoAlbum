"use client";

import { useRef } from "react";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** A short clip in a grid: the poster until hovered or focused, then it plays muted and loops; the lightbox has controls. */
export function ClipTile({ src, poster, alt, durationS }: { src: string; poster: string; alt: string; durationS: number | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  const play = () => void ref.current?.play().catch(() => {});
  const stop = () => {
    const v = ref.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  };
  return (
    <span className="block w-full h-full relative" onMouseEnter={play} onMouseLeave={stop} onFocus={play} onBlur={stop}>
      <video ref={ref} src={src} poster={poster} muted loop playsInline preload="none" aria-label={alt} className="w-full h-full object-cover" />
      <span className="absolute bottom-1 right-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5 pointer-events-none" aria-hidden="true">
        ▶ {durationS ? fmt(durationS) : "clip"}
      </span>
    </span>
  );
}
