"use client";

import { useRef } from "react";

/** m:ss, rounded as a whole so 59.7s reads 1:00 rather than 0:60. */
export const formatClipDuration = (s: number) => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

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
        ▶ {durationS ? formatClipDuration(durationS) : "clip"}
      </span>
    </span>
  );
}
