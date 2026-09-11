"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { YouTubeEmbed } from "@/components/videos/YouTubeEmbed";

export type LightboxPhoto = { id: string; mediumUrl: string; width: number | null; height: number | null; caption: string | null; alt: string; /** Shown to members only; never set for anonymous viewers. */ uploadedBy?: string | null; /** Set for embedded videos: the lightbox shows the click-to-play facade instead of the image. */ youtubeId?: string | null; title?: string | null };

export function Lightbox({ photos, index, onClose, onNavigate, showDetailLink = true }: { photos: LightboxPhoto[]; index: number; onClose: () => void; onNavigate: (i: number) => void; showDetailLink?: boolean }) {
  const photo = photos[index];
  const prev = useCallback(() => onNavigate((index - 1 + photos.length) % photos.length), [index, photos.length, onNavigate]);
  const next = useCallback(() => onNavigate((index + 1) % photos.length), [index, photos.length, onNavigate]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && dialogRef.current) {
        // Keep keyboard focus inside the dialog.
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      opener?.focus?.();
    };
    // Focus management runs once per open; navigation between photos keeps focus where it is.
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, prev, next]);

  if (!photo) return null;
  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={onClose} role="dialog" aria-modal="true" aria-label="Photo viewer">
      <div className="flex items-center justify-between p-3 text-white/80 text-sm" onClick={(e) => e.stopPropagation()}>
        <span>
          {index + 1} / {photos.length}
        </span>
        <div className="flex items-center gap-3">
          {showDetailLink && (
            <Link href={`/photos/${photo.id}`} className="underline underline-offset-2 hover:text-white">
              Details
            </Link>
          )}
          <button ref={closeRef} onClick={onClose} className="px-2 py-1 rounded hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label="Close">
            ✕
          </button>
        </div>
      </div>
      <div className="flex-1 relative flex items-center justify-center min-h-0 px-12">
        {photos.length > 1 && (
          <button onClick={(e) => { e.stopPropagation(); prev(); }} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/80 hover:text-white text-3xl p-3" aria-label="Previous">
            ‹
          </button>
        )}
        {photo.youtubeId ? (
          <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
            <YouTubeEmbed videoId={photo.youtubeId} posterUrl={photo.mediumUrl} title={photo.title ?? photo.alt} />
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo.mediumUrl} alt={photo.alt} className="max-h-full max-w-full object-contain select-none" onClick={(e) => e.stopPropagation()} />
        )}
        {photos.length > 1 && (
          <button onClick={(e) => { e.stopPropagation(); next(); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/80 hover:text-white text-3xl p-3" aria-label="Next">
            ›
          </button>
        )}
      </div>
      {(photo.caption || photo.uploadedBy) && (
        <p className="text-center text-white/90 p-3 text-sm">
          {photo.caption}
          {photo.uploadedBy && <span className="block text-white/60 text-xs mt-1">Uploaded by {photo.uploadedBy}</span>}
        </p>
      )}
    </div>
  );
}

/** Small hook so any grid can open the shared lightbox. */
export function useLightbox() {
  const [index, setIndex] = useState<number | null>(null);
  return { index, open: setIndex, close: () => setIndex(null) };
}
