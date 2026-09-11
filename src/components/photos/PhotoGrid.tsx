"use client";

import { Lightbox, useLightbox, type LightboxPhoto } from "./Lightbox";
import { useSelectionContext } from "./selection";
import { ClipTile } from "./ClipTile";

export type GridPhoto = LightboxPhoto & { thumbUrl: string; status: "PENDING" | "PROCESSING" | "READY" | "FAILED"; badge?: string | null; unavailable?: boolean; /** Members only: the collections holding this item, shown as chips. */ collections?: { slug: string; title: string }[] };

export function PhotoGrid({ photos, showDetailLink = true, emptyMessage = "No photos yet.", selectable: selectableProp, selected: selectedProp, onToggle: onToggleProp }: { photos: GridPhoto[]; showDetailLink?: boolean; emptyMessage?: string; selectable?: boolean; selected?: Set<string>; onToggle?: (id: string) => void }) {
  const lb = useLightbox();
  // A grid inside a SelectionProvider (global timeline, unassigned photos) takes its selection from context.
  const ctx = useSelectionContext();
  const selectable = selectableProp ?? (ctx?.active ?? false);
  const selected = selectedProp ?? ctx?.selected;
  const onToggle = onToggleProp ?? ctx?.toggle;
  const ready = photos.filter((p) => p.status === "READY");
  if (photos.length === 0) return <p className="text-muted text-sm">{emptyMessage}</p>;

  return (
    <>
      <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
        {photos.map((p) => {
          const readyIndex = ready.findIndex((r) => r.id === p.id);
          return (
            <li key={p.id} className="tile-lazy relative aspect-square rounded-theme overflow-hidden bg-surface-alt border border-border group">
              {p.status === "READY" ? (
                <button onClick={() => (selectable ? onToggle?.(p.id) : lb.open(readyIndex))} className={`block w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectable && selected?.has(p.id) ? "ring-4 ring-primary ring-inset" : ""}`} aria-pressed={selectable ? selected?.has(p.id) : undefined}>
                  {p.videoUrl ? (
                    <ClipTile src={p.videoUrl} poster={p.thumbUrl} alt={p.alt} durationS={p.durationS ?? null} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.thumbUrl} alt={p.alt} title={p.uploadedBy ? `Uploaded by ${p.uploadedBy}` : undefined} loading="lazy" className="w-full h-full object-cover transition-transform group-hover:scale-[1.03]" />
                  )}
                </button>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-muted p-2 text-center">
                  {p.status === "FAILED" ? "Processing failed" : "Processing…"}
                </div>
              )}
              {p.badge && <span className="absolute top-1 left-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5">{p.badge}</span>}
              {p.collections && p.collections.length > 0 && (
                <span className={`absolute bottom-1 left-1 flex flex-wrap gap-1 pointer-events-none ${p.youtubeId ? (p.unavailable ? "right-28" : "right-14") : "right-1"}`} aria-label={`In ${p.collections.map((c) => c.title).join(", ")}`}>
                  {p.collections.slice(0, 2).map((c) => (
                    <span key={c.slug} className="text-[10px] bg-white/85 text-text rounded px-1.5 py-0.5 truncate max-w-[70%]">{c.title}</span>
                  ))}
                  {p.collections.length > 2 && <span className="text-[10px] bg-white/85 text-text rounded px-1.5 py-0.5">+{p.collections.length - 2}</span>}
                </span>
              )}
              {p.youtubeId && (
                <span className="absolute bottom-1 right-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5 pointer-events-none" aria-hidden="true">
                  ▶ {p.unavailable ? "no longer available" : "video"}
                </span>
              )}
              {selectable && (
                <span className={`absolute top-1 right-1 w-5 h-5 rounded-full border-2 border-white flex items-center justify-center text-[10px] ${selected?.has(p.id) ? "bg-primary text-primary-fg" : "bg-black/40"}`} aria-hidden="true">
                  {selected?.has(p.id) ? "✓" : ""}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {lb.index !== null && <Lightbox photos={ready} index={lb.index} onClose={lb.close} onNavigate={lb.open} showDetailLink={showDetailLink} />}
    </>
  );
}
