"use client";

import { useState } from "react";

/**
 * Click-to-play facade: our locally stored poster with a play badge, and only after a tap an iframe from the
 * privacy-enhanced host. Nothing is requested from YouTube until then.
 */
export function YouTubeEmbed({ videoId, posterUrl, title, className = "" }: { videoId: string; posterUrl: string; title: string; className?: string }) {
  const [playing, setPlaying] = useState(false);
  if (playing) {
    return (
      <div className={`relative aspect-video bg-black ${className}`}>
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${videoId}?rel=0&autoplay=1`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 w-full h-full"
        />
      </div>
    );
  }
  return (
    <button type="button" onClick={() => setPlaying(true)} className={`group relative block aspect-video w-full bg-black overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-white ${className}`} aria-label={`Play ${title} on YouTube`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={posterUrl} alt="" className="w-full h-full object-cover" />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="rounded-full bg-black/70 text-white w-16 h-16 flex items-center justify-center text-3xl transition-transform group-hover:scale-110" aria-hidden="true">▶</span>
      </span>
      <span className="absolute bottom-2 left-2 right-2 text-center text-xs text-white/80 bg-black/50 rounded px-2 py-1">Playing sends your request to YouTube</span>
    </button>
  );
}
