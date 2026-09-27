"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { MapViewDynamic } from "./MapViewDynamic";
import { PHOTO_DRAG_TYPE, photoPickedUp } from "@/components/timeline/TimelineDrop";
import { placeOnMap } from "@/app/photos/bulk-actions";
import type { MapPayload, PhotoFeatureProps } from "@/lib/map/geojson";
import type { MapTheme } from "@/lib/map/theme";
import type { TrayPhoto } from "@/lib/photos/unplaced";
import { spreadFeatures, withMoved } from "@/lib/map/jitter";

type Pin = GeoJSON.Feature<GeoJSON.Point, PhotoFeatureProps>;

/**
 * Putting photographs on the map by pointing at where they were taken.
 *
 * A whole afternoon usually happened in one place, and the album cannot know where: a scan has no GPS, a phone
 * strips it on the way out, and the helper's guess is a guess. Naming the spot once and dropping the afternoon on
 * it is far less work than typing coordinates twenty times, so that is what this is — a tray of what still needs
 * placing beside a map to drop it on.
 *
 * Dragging is the quick way and not the only way: tap a photograph, then tap the map, and the same thing happens.
 * That is what works on a phone, and what works from a keyboard.
 */
export function PlaceOnMap({ src, theme, initial, tripTitle }: { src: string; theme: MapTheme; initial: { photos: TrayPhoto[]; nextCursor: string | null; total: number }; tripTitle: string | null }) {
  const router = useRouter();
  const [tray, setTray] = useState<TrayPhoto[]>(initial.photos);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [data, setData] = useState<MapPayload | null>(null);
  // The map opens on the album, so it waits for the album: bounds given after the map is made are not looked at.
  const [ready, setReady] = useState(false);
  /** Pins placed on this screen, by photograph: each replaces whatever pin that photograph had. */
  const [placed, setPlaced] = useState<ReadonlyMap<string, Pin>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  /** A photograph already on the map that is being moved to where it actually was. */
  const [moving, setMoving] = useState<{ id: string; label: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    fetch(src)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("map"))))
      .then((d: MapPayload) => { if (alive) setData(d); })
      .catch(() => {})
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [src]);

  const photos = useMemo(() => {
    const base = data?.photos ?? { type: "FeatureCollection" as const, features: [] };
    // Several dropped on one spot would otherwise be one pin with the rest hidden under it.
    return { ...base, features: placed.size ? spreadFeatures(withMoved(base.features, placed)) : base.features } as MapPayload["photos"];
  }, [data, placed]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Put these on that spot, take them out of the tray, and leave a pin behind so the map shows what happened. */
  const place = (ids: string[], at: { lat: number; lng: number }) =>
    start(async () => {
      if (!ids.length) return;
      // Only what was saved moves: a photograph somebody else uploaded stays where it was, on the map and in the tray.
      const saved = await placeOnMap(ids, at.lat, at.lng);
      const n = saved.length;
      if (n === 0) { setNotice("Nothing was placed: only the member who uploaded an item, or an admin, can place it."); return; }
      // Move the pin itself — one picked up off the map as much as one from the tray — so it is shown once, where it now is.
      setPlaced((prev) => {
        const next = new Map(prev);
        for (const id of saved) {
          const was = prev.get(id)?.properties ?? data?.photos.features.find((f) => f.properties.id === id)?.properties;
          const t = tray.find((p) => p.id === id);
          const properties: PhotoFeatureProps | null = was
            ? { ...was, gpsSource: "MANUAL" }
            : t
              ? { id: t.id, thumbUrl: t.thumbUrl, mediumUrl: t.thumbUrl, caption: t.label, takenAt: t.takenAt, tripSlug: "", tripTitle: t.tripTitle ?? "", activityId: null, gpsSource: "MANUAL", day: t.day, activityTitle: null, uploaderId: null, uploaderName: null }
              : null;
          if (properties) next.set(id, { type: "Feature", geometry: { type: "Point", coordinates: [at.lng, at.lat] }, properties });
        }
        return next;
      });
      setTray((prev) => prev.filter((p) => !saved.includes(p.id)));
      setSelected(new Set());
      const skipped = ids.length - n;
      setNotice(`${n} photograph${n === 1 ? "" : "s"} placed. ${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}${skipped ? `. ${skipped} not yours to place, left where ${skipped === 1 ? "it was" : "they were"}.` : ""}`);
      router.refresh();
    });

  /** Dropping one of several that are ticked places the lot: that is what ticking them was for. */
  const dropped = (id: string, at: { lat: number; lng: number }) => place(selected.has(id) ? [...selected] : [id], at);

  const chosen = [...selected];
  return (
    <div className="grid lg:grid-cols-[1fr_20rem] gap-4">
      <div className="h-[60vh] lg:h-[72vh] rounded-theme overflow-hidden border border-border relative">
        {!ready ? (
          <div className="w-full h-full bg-surface-alt animate-pulse" />
        ) : (
          <MapViewDynamic
            photos={photos}
            tracks={data?.tracks ?? { type: "FeatureCollection", features: [] }}
            bounds={data?.bounds ?? null}
            theme={theme}
            onMapClick={(at) => {
              if (moving) { place([moving.id], at); setMoving(null); return; }
              if (chosen.length) { place(chosen, at); return; }
              setNotice("Pick a photograph from the list, or one already on the map, then point at where it was taken.");
            }}
            // A pin that is in the wrong spot is picked up by touching it, and put down with the next point at the map.
            onPhotoClick={(id) => {
              const f = photos.features.find((x) => x.properties.id === id);
              setMoving({ id, label: f?.properties.caption ?? "that photograph" });
              setNotice(null);
            }}
            acceptsDrop={(e) => e.dataTransfer.types.includes(PHOTO_DRAG_TYPE)}
            onDropAt={(at, e) => {
              const id = e.dataTransfer.getData(PHOTO_DRAG_TYPE);
              if (id) dropped(id, at);
            }}
          />
        )}
        {moving && (
          <p role="status" className="absolute left-2 top-2 right-2 rounded-theme bg-primary text-primary-fg text-xs px-3 py-2 flex items-center justify-between gap-2" data-testid="moving-pin">
            <span>Moving “{moving.label}” — point at where it was taken.</span>
            <button type="button" className="underline underline-offset-2" onClick={() => setMoving(null)}>Cancel</button>
          </p>
        )}
        {notice && (
          <p role="status" className="absolute left-2 bottom-2 right-2 rounded-theme bg-black/70 text-white text-xs px-3 py-2" data-testid="place-notice">{notice}</p>
        )}
      </div>

      <aside className="space-y-3">
        <div>
          <h2 className="font-display text-lg font-semibold">{initial.total} to place{tripTitle ? ` on ${tripTitle}` : ""}</h2>
          <p className="text-muted text-sm mt-1">
            Drag one onto the map, or tap it and then tap the spot. Check several that were taken in the same place and
            they all land together. A pin already on the map can be picked up the same way and put down where it
            actually was.
          </p>
        </div>
        {chosen.length > 0 && (
          <p className="text-sm flex items-center gap-2">
            <span>{chosen.length} picked.</span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </p>
        )}
        {tray.length === 0 ? (
          <p className="text-muted text-sm" data-testid="tray-empty">Nothing is waiting for a place.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 max-h-[52vh] overflow-y-auto pr-1" data-testid="place-tray">
            {tray.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-pressed={selected.has(p.id)}
                  aria-label={`${p.label}${p.guess ? ` — ${p.guess}` : ""}`}
                  title={`${p.label}${p.guess ? ` — the helper guessed ${p.guess}` : ""}`}
                  disabled={pending}
                  onClick={() => toggle(p.id)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(PHOTO_DRAG_TYPE, p.id);
                    e.dataTransfer.setData("text/plain", p.id);
                    e.dataTransfer.effectAllowed = "move";
                    photoPickedUp(p.id);
                  }}
                  onDragEnd={() => photoPickedUp(null)}
                  className={`relative block w-full aspect-square rounded-theme overflow-hidden border bg-surface-alt cursor-grab active:cursor-grabbing focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected.has(p.id) ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary"}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.thumbUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
                  {p.guess && <span className="absolute bottom-0 inset-x-0 text-[10px] bg-black/60 text-white px-1 py-0.5 truncate">guessed</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {initial.nextCursor && tray.length > 0 && (
          <p className="text-xs text-muted">Showing the first {initial.photos.length}. Place these and reload for more.</p>
        )}
      </aside>
    </div>
  );
}
