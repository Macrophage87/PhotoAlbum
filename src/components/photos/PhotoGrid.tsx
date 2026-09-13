"use client";

import { Lightbox, useLightbox, type LightboxPhoto } from "./Lightbox";
import { useSelectionContext } from "./selection";
import { ClipTile } from "./ClipTile";
import { FavouriteButton } from "@/components/favourites/FavouriteButton";
import type { FavouriteState } from "@/lib/favourites/queries";

export type GridPhoto = LightboxPhoto & {
  thumbUrl: string;
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  badge?: string | null;
  unavailable?: boolean;
  /** Members only: the collections holding this item, shown as chips. */
  collections?: { slug: string; title: string }[];
  /** What the tile says on hover: the caption, then when and where, which is what anyone is actually looking for. */
  takenAt?: string | null;
  tzOffsetMin?: number | null;
  placeName?: string | null;
  /** Members only: whether this is one of theirs, and how many of the family have marked it. */
  favourite?: FavouriteState | null;
  /** A panorama: given a tile of its own shape rather than a square crop of its middle. */
  panorama?: { projection: string | null; panoUrl: string } | null;
};

/** The date a tile shows on hover, in the photo's own zone rather than the reader's. */
/** A panorama gets the wide tile only once it is ready and there is a long copy to fill it. */
function wideTile(p: GridPhoto): boolean {
  return Boolean(p.panorama && p.status === "READY" && !p.videoUrl && !p.youtubeId);
}

export function tileDate(takenAt?: string | null, tzOffsetMin?: number | null): string | null {
  if (!takenAt) return null;
  const at = new Date(takenAt);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(at.getTime() + (tzOffsetMin ?? 0) * 60_000));
}

export function PhotoGrid({ photos, emptyMessage = "No photos yet.", selectable: selectableProp, selected: selectedProp, onToggle: onToggleProp }: { photos: GridPhoto[]; emptyMessage?: string; selectable?: boolean; selected?: Set<string>; onToggle?: (id: string) => void }) {
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
            // A panorama in a square tile is a crop of its middle, which is the one part that says least about it:
            // it takes two columns and its own shape, and the whole sweep is shown rather than cut to fit.
            <li key={p.id} className={`tile-lazy relative rounded-theme overflow-hidden bg-surface-alt border border-border group ${wideTile(p) ? "col-span-2 aspect-[2/1]" : "aspect-square"}`}>
              {p.status === "READY" ? (
                <button onClick={() => (selectable ? onToggle?.(p.id) : lb.open(readyIndex))} className={`block w-full h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectable && selected?.has(p.id) ? "ring-4 ring-primary ring-inset" : ""}`} aria-pressed={selectable ? selected?.has(p.id) : undefined}>
                  {p.videoUrl ? (
                    <ClipTile src={p.videoUrl} poster={p.thumbUrl} alt={p.alt} durationS={p.durationS ?? null} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={wideTile(p) ? p.panorama!.panoUrl : p.thumbUrl} alt={p.alt} loading="lazy" className={`w-full h-full transition-transform ${wideTile(p) ? "object-contain bg-black/5" : "object-cover group-hover:scale-[1.03]"}`} />
                  )}
                </button>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-muted p-2 text-center">
                  {p.status === "FAILED" ? "Processing failed" : "Processing…"}
                </div>
              )}
              {/* What it is, when and where: legible on hover without covering the picture the rest of the time. */}
              {(p.caption || p.title || tileDate(p.takenAt, p.tzOffsetMin) || p.placeName) && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 p-1.5 pt-6 bg-gradient-to-t from-black/80 via-black/45 to-transparent opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity" data-testid="tile-hover">
                  {(p.caption || p.title) && <span className="block text-[11px] leading-snug text-white line-clamp-2">{p.caption ?? p.title}</span>}
                  {(tileDate(p.takenAt, p.tzOffsetMin) || p.placeName) && (
                    <span className="block text-[10px] text-white/75 truncate">{[tileDate(p.takenAt, p.tzOffsetMin), p.placeName].filter(Boolean).join(" · ")}</span>
                  )}
                </span>
              )}
              {p.favourite && (
                <span className="absolute top-1 right-1 rounded-full bg-black/45 backdrop-blur-sm">
                  <FavouriteButton kind="photo" id={p.id} initial={p.favourite} dark size="sm" />
                </span>
              )}
              {p.badge && <span className="absolute top-1 left-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5">{p.badge}</span>}
              {wideTile(p) && <span className="absolute top-1 left-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5" style={p.badge ? { top: "1.6rem" } : undefined}>{p.panorama!.projection === "EQUIRECTANGULAR_360" ? "360°" : "Panorama"}</span>}
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
      {lb.index !== null && <Lightbox photos={ready} index={lb.index} onClose={lb.close} onNavigate={lb.open} />}
    </>
  );
}
