"use client";

import { Lightbox, useLightbox, type LightboxPhoto } from "./Lightbox";

export type GridPhoto = LightboxPhoto & { thumbUrl: string; status: "PENDING" | "PROCESSING" | "READY" | "FAILED"; badge?: string | null };

export function PhotoGrid({ photos, showDetailLink = true, emptyMessage = "No photos yet." }: { photos: GridPhoto[]; showDetailLink?: boolean; emptyMessage?: string }) {
  const lb = useLightbox();
  const ready = photos.filter((p) => p.status === "READY");
  if (photos.length === 0) return <p className="text-muted text-sm">{emptyMessage}</p>;

  return (
    <>
      <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
        {photos.map((p) => {
          const readyIndex = ready.findIndex((r) => r.id === p.id);
          return (
            <li key={p.id} className="relative aspect-square rounded-theme overflow-hidden bg-surface-alt border border-border group">
              {p.status === "READY" ? (
                <button onClick={() => lb.open(readyIndex)} className="block w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.thumbUrl} alt={p.alt} loading="lazy" className="w-full h-full object-cover transition-transform group-hover:scale-[1.03]" />
                </button>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-muted p-2 text-center">
                  {p.status === "FAILED" ? "Processing failed" : "Processing…"}
                </div>
              )}
              {p.badge && <span className="absolute top-1 left-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5">{p.badge}</span>}
            </li>
          );
        })}
      </ul>
      {lb.index !== null && <Lightbox photos={ready} index={lb.index} onClose={lb.close} onNavigate={lb.open} showDetailLink={showDetailLink} />}
    </>
  );
}
