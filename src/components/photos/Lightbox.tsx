"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { YouTubeEmbed } from "@/components/videos/YouTubeEmbed";
import { PanoramaView, PanoramaHint } from "./PanoramaView";
import { ScanViewer } from "@/components/scans/ScanViewer";
import { panoramaLabel } from "@/lib/images/panorama";
import { PetTagger } from "@/components/people/PetTagger";
import { LightboxInfo } from "./LightboxInfo";

export type LightboxPhoto = { id: string; mediumUrl: string; width: number | null; height: number | null; caption: string | null; alt: string; /** Shown to members only; never set for anonymous viewers. */ uploadedBy?: string | null; /** Set for embedded videos: the lightbox shows the click-to-play facade instead of the image. */ youtubeId?: string | null; title?: string | null; /** Set for uploaded clips: plays inline with controls. */ videoUrl?: string | null; durationS?: number | null; /** Members can tag a pet from here. */ canTag?: boolean; /** Full-size file, opened by a second click on the picture. */ originalUrl?: string | null; /** A panorama, shown filling the height and panned sideways rather than shrunk to fit. */ panorama?: { projection: string | null; panoUrl: string } | null; /** A 3D scan, turned in place. */ scan?: { format: string | null; modelUrl: string; hasPoster: boolean } | null };

export function Lightbox({ photos, index, onClose, onNavigate, share = null }: { photos: LightboxPhoto[]; index: number; onClose: () => void; onNavigate: (i: number) => void; /** On a share page: the token that lets the info request through without a cookie. */ share?: { token: string; kind: string } | null }) {
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
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, textarea"));
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
          <button ref={closeRef} onClick={onClose} className="px-2 py-1 rounded hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label="Close">
            ✕
          </button>
        </div>
      </div>
      {/*
        On a phone the two panes share the screen rather than the picture pushing the details off the bottom: the
        media takes the top half and the details scroll in what is left, so the title and date are there without
        anyone having to guess that the page scrolls. On a wide screen the details are a column beside the picture.
      */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row lg:overflow-hidden">
        <div className="relative shrink-0 lg:shrink lg:flex-1 flex flex-col items-center justify-center lg:min-h-0 px-12 py-2 gap-2 lg:gap-3">
          {photos.length > 1 && (
            <button onClick={(e) => { e.stopPropagation(); prev(); }} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/80 hover:text-white text-3xl p-3" aria-label="Previous">
              ‹
            </button>
          )}
          {photo.videoUrl ? (
            <video key={photo.id} src={photo.videoUrl} poster={photo.mediumUrl} controls autoPlay playsInline className="max-h-[46vh] lg:max-h-[80vh] max-w-full" onClick={(e) => e.stopPropagation()} />
          ) : photo.youtubeId ? (
            <div className="w-full max-w-5xl" onClick={(e) => e.stopPropagation()}>
              <YouTubeEmbed videoId={photo.youtubeId} posterUrl={photo.mediumUrl} title={photo.title ?? photo.alt} />
            </div>
          ) : photo.scan ? (
            <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
              <ScanViewer photoId={photo.id} modelUrl={photo.scan.modelUrl} format={photo.scan.format} posterUrl={photo.scan.hasPoster ? photo.mediumUrl : null} canPoster={Boolean(photo.canTag)} alt={photo.alt} className="h-[46vh] lg:h-[62vh]" />
            </div>
          ) : photo.panorama ? (
            // A panorama fills the height and is dragged: fitting a 10:1 sweep to the width of a phone leaves a
            // strip an inch tall, which is the one way of showing it that throws away why it was taken.
            <PanoramaView
              src={photo.panorama.panoUrl}
              alt={photo.alt}
              wrap={photo.panorama.projection === "EQUIRECTANGULAR_360"}
              axis={(photo.width ?? 0) >= (photo.height ?? 0) ? "horizontal" : "vertical"}
              className="h-[46vh] lg:h-[72vh] w-full max-w-full bg-black/40"
            >
              <PanoramaHint label={panoramaLabel(photo.panorama.projection)} />
            </PanoramaView>
          ) : photo.originalUrl ? (
            // A second click on the picture opens the full-size file in its own tab.
            <a href={photo.originalUrl} target="_blank" rel="noreferrer" title="Open the full-size photo" className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photo.mediumUrl} alt={photo.alt} className="max-h-[46vh] lg:max-h-[72vh] max-w-full object-contain select-none" />
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo.mediumUrl} alt={photo.alt} className="max-h-[46vh] lg:max-h-[72vh] max-w-full object-contain select-none" onClick={(e) => e.stopPropagation()} />
          )}
          {photos.length > 1 && (
            <button onClick={(e) => { e.stopPropagation(); next(); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/80 hover:text-white text-3xl p-3" aria-label="Next">
              ›
            </button>
          )}
          {photo.caption && (
            <p className="max-w-3xl text-center text-white text-base sm:text-xl font-medium leading-snug drop-shadow" data-testid="lightbox-caption" onClick={(e) => e.stopPropagation()}>{photo.caption}</p>
          )}
        </div>
        <aside className="flex-1 min-h-0 overflow-y-auto lg:flex-none lg:w-80 xl:w-96 bg-black/40 border-t lg:border-t-0 lg:border-l border-white/10" onClick={(e) => e.stopPropagation()}>
          <LightboxInfo key={photo.id} photoId={photo.id} share={share} />
          {photo.canTag && <div className="px-4 pb-4 text-sm text-white/90"><PetTagger photoId={photo.id} dark /></div>}
        </aside>
      </div>
    </div>
  );
}

/** Small hook so any grid can open the shared lightbox. */
export function useLightbox() {
  const [index, setIndex] = useState<number | null>(null);
  return { index, open: setIndex, close: () => setIndex(null) };
}
