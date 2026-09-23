"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { MapViewDynamic } from "./MapViewDynamic";
import type { MapPhotoProps } from "./MapView";
import { placePhotos, restorePlaces, type PlaceBefore } from "@/app/photos/bulk-actions";
import type { MapPayload } from "@/lib/map/geojson";
import type { MapTheme } from "@/lib/map/theme";
import type { PlacingPhoto } from "@/lib/photos/placing";
import type { GeocodeHit } from "@/app/api/geocode/route";
import { formatDay } from "@/lib/time/format";
import { NONE_SLOT } from "@/lib/map/colour-by";

type Spot = { lat: number; lng: number; name?: string | null };

/** A small box round one point, for the map to fly to: close enough to see the street, far enough to see the town. */
function around(at: { lat: number; lng: number }, span = 0.01): [[number, number], [number, number]] {
  return [[at.lng - span, at.lat - span * 0.6], [at.lng + span, at.lat + span * 0.6]];
}

function boxOf(points: { lat: number; lng: number }[]): [[number, number], [number, number]] | null {
  if (!points.length) return null;
  if (points.length === 1) return around(points[0], 0.004);
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}

const BADGE: Record<PlacingPhoto["by"], { text: string; cls: string } | null> = {
  none: { text: "No place", cls: "bg-amber-500 text-black" },
  guess: { text: "Guessed", cls: "bg-amber-200 text-black" },
  hand: { text: "Placed", cls: "bg-emerald-600 text-white" },
  camera: null,
  track: null,
};

/**
 * Putting a trip's photographs where they were taken, made for a phone.
 *
 * Half the screen is the map and half is the photographs, because the job is exactly two things: choosing which
 * pictures, and pointing at where. Choose as many as were taken in one spot — a whole day at once, if the day was
 * spent in one town — then tap the map. A pin appears where you tapped, so a tap that lands a street away can be
 * tapped again before anything is saved, and nothing moves until "Put them here" is pressed. Straight afterwards
 * there is an Undo, because on a small screen the likeliest mistake is the one just made.
 *
 * Getting the map to the right place is its own small job on a phone, where pinching across a continent is tiresome:
 * type a town or a landmark and the map goes there, or, standing in the spot itself, press "Where I am".
 */
export function PlaceStudio({ photos: initial, total, theme, tracks, bounds }: { photos: PlacingPhoto[]; total: number; theme: MapTheme; tracks: MapPayload["tracks"]; bounds: MapPayload["bounds"] }) {
  const [items, setItems] = useState(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pin, setPin] = useState<Spot | null>(null);
  const [focus, setFocus] = useState<MapPayload["bounds"]>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: PlaceBefore[] } | null>(null);
  const [hits, setHits] = useState<GeocodeHit[] | null>(null);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [looking, startLooking] = useTransition();

  const chosen = items.filter((p) => selected.has(p.id));
  const count = chosen.length;

  const days = useMemo(() => {
    const out: { day: string | null; photos: PlacingPhoto[] }[] = [];
    for (const p of items) {
      const last = out[out.length - 1];
      if (last && last.day === p.day) last.photos.push(p);
      else out.push({ day: p.day, photos: [p] });
    }
    return out;
  }, [items]);

  // Only what is listed goes on the map, the chosen ones ringed in blue and the rest in gray, so a group's ring shows
  // how much of it is chosen.
  const mapPhotos = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: items
        .filter((p) => p.lat !== null && p.lng !== null)
        .map((p): GeoJSON.Feature<GeoJSON.Point, MapPhotoProps> => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.lng!, p.lat!] },
          properties: { id: p.id, thumbUrl: p.thumbUrl, mediumUrl: p.thumbUrl, caption: p.label, takenAt: p.takenAt, tripSlug: "", tripTitle: "", activityId: null, gpsSource: null, day: p.day, activityTitle: null, uploaderId: null, uploaderName: null, slot: selected.has(p.id) ? 0 : NONE_SLOT },
        })),
    }),
    [items, selected],
  );
  const startBounds = useMemo(() => bounds ?? boxOf(initial.filter((p) => p.lat !== null).map((p) => ({ lat: p.lat!, lng: p.lng! }))), [bounds, initial]);

  const toggle = (id: string) => {
    setNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const setMany = (ids: string[], on: boolean) => {
    setNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };
  const clear = () => {
    setSelected(new Set());
    setPin(null);
  };

  /** Where the pin goes, from a tap, a looked-up place or the phone's own position. */
  const pointAt = (spot: Spot, fly: boolean) => {
    if (fly) setFocus(around(spot));
    if (!count) {
      setNotice({ text: "First choose the photos taken there: tap them in the list." });
      return;
    }
    setNotice(null);
    setPin(spot);
  };

  const put = () =>
    start(async () => {
      if (!pin || !count) return;
      const ids = chosen.map((p) => p.id);
      try {
        const r = await placePhotos(ids, pin.lat, pin.lng, pin.name ?? null);
        if (r.count === 0) {
          setNotice({ text: "Nothing was moved: only whoever added a photo, or an admin, can place it." });
          return;
        }
        const moved = new Set(r.before.map((b) => b.id));
        setItems((prev) => prev.map((p) => (moved.has(p.id) ? { ...p, lat: pin.lat, lng: pin.lng, by: "hand", guess: null } : p)));
        setNotice({ text: `${r.count} photo${r.count === 1 ? "" : "s"} placed${pin.name ? ` at ${pin.name}` : ""}.`, undo: r.before });
        clear();
      } catch {
        setNotice({ text: "That did not save. Check the connection and press it again." });
      }
    });

  const undo = (before: PlaceBefore[]) =>
    start(async () => {
      try {
        await restorePlaces(before);
        const back = new Map(before.map((b) => [b.id, b]));
        setItems((prev) =>
          prev.map((p) => {
            const b = back.get(p.id);
            if (!b) return p;
            const by: PlacingPhoto["by"] = b.lat === null ? "none" : b.gpsSource === "ESTIMATE" ? "guess" : b.gpsSource === "MANUAL" ? "hand" : b.gpsSource === "TRACK" ? "track" : "camera";
            return { ...p, lat: b.lat, lng: b.lng, by };
          }),
        );
        setNotice({ text: "Undone. They are back where they were." });
      } catch {
        setNotice({ text: "That did not undo. Check the connection and press it again." });
      }
    });

  const lookup = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get("q") ?? "").trim();
    if (q.length < 2) return;
    startLooking(async () => {
      setLookupNote(null);
      try {
        const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { credentials: "same-origin" });
        const j = (await r.json()) as { hits: GeocodeHit[]; disabled?: boolean };
        if (j.disabled) return setLookupNote("Looking places up is turned off here. Move the map with your fingers instead.");
        if (!r.ok) return setLookupNote("Looking places up is not working right now. Move the map with your fingers instead.");
        if (!j.hits.length) return setLookupNote("Nothing found. Try a town or a landmark.");
        if (j.hits.length === 1) {
          pointAt({ lat: j.hits[0].lat, lng: j.hits[0].lng, name: j.hits[0].label }, true);
          setHits(null);
        } else setHits(j.hits);
      } catch {
        setLookupNote("Looking places up is not working right now. Move the map with your fingers instead.");
      }
    });
  };

  const whereIAm = () => {
    if (!("geolocation" in navigator)) return setLookupNote("This phone will not say where it is.");
    setLookupNote("Finding where you are…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLookupNote(null);
        pointAt({ lat: pos.coords.latitude, lng: pos.coords.longitude }, true);
      },
      () => setLookupNote("The phone did not say where it is. It may need permission in its settings."),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const placedAlready = chosen.filter((p) => p.lat !== null);
  const button = "inline-flex items-center justify-center rounded-theme px-4 h-11 text-base font-medium disabled:opacity-60";

  return (
    // Columns that may not grow past the screen: a grid column otherwise widens to fit the widest thing in it, and on a
    // phone that pushed half the buttons off the right edge.
    <div className="grid gap-4 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
      {/* The map: on a phone it stays at the top while the photographs scroll underneath it. */}
      <div className="sticky top-14 z-30 -mx-4 sm:mx-0 bg-bg lg:order-2 lg:top-20" data-testid="place-map">
        <form onSubmit={lookup} className="flex gap-2 px-4 sm:px-0 py-2">
          <label htmlFor="place-lookup" className="sr-only">Find a town, landmark or address</label>
          <input id="place-lookup" name="q" type="search" placeholder="Find a town or landmark" className="h-11 min-w-0 flex-1 rounded-theme border border-border bg-surface px-3 text-base" />
          <button type="submit" disabled={looking} className={`${button} bg-surface-alt border border-border`}>{looking ? "…" : "Find"}</button>
          <button type="button" onClick={whereIAm} className={`${button} bg-surface-alt border border-border px-3 whitespace-nowrap`} title="Use where this phone is now">
            Where I am
          </button>
        </form>
        {(hits || lookupNote) && (
          <div className="px-4 sm:px-0 pb-2 space-y-1">
            {lookupNote && <p className="text-sm text-muted" role="status">{lookupNote}</p>}
            {hits && (
              <ul className="rounded-theme border border-border bg-surface divide-y divide-border max-h-40 overflow-y-auto" aria-label="Places found">
                {hits.map((h) => (
                  <li key={`${h.lat},${h.lng}`}>
                    <button type="button" className="w-full text-left px-3 py-2.5 text-sm hover:bg-surface-alt" onClick={() => { setHits(null); pointAt({ lat: h.lat, lng: h.lng, name: h.label }, true); }}>{h.label}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="relative h-[42dvh] lg:h-[calc(100dvh-12rem)] border-y sm:border border-border sm:rounded-theme overflow-hidden">
          <MapViewDynamic
            photos={mapPhotos}
            tracks={tracks}
            bounds={startBounds}
            theme={theme}
            rings
            directPhotoClick
            marker={pin}
            focusBounds={focus}
            onMapClick={(at) => pointAt(at, false)}
            // A pin already on the map is chosen by tapping it, which is how one in the wrong spot is found and moved.
            onPhotoClick={toggle}
          />
        </div>
        {/* What to do next, always in the same place under the map, in words. */}
        <div className="px-4 sm:px-0 py-2 min-h-14 flex flex-wrap items-center gap-2" data-testid="place-bar" aria-live="polite">
          {notice ? (
            <>
              <p className="text-sm flex-1" data-testid="place-notice">{notice.text}</p>
              {notice.undo && <button type="button" disabled={pending} onClick={() => undo(notice.undo!)} className={`${button} border border-border bg-surface`}>Undo</button>}
            </>
          ) : pin && count ? (
            <>
              <p className="text-sm flex-1">Put {count === 1 ? "this photo" : `these ${count} photos`} {pin.name ? `at ${pin.name}` : "where the pin is"}? Tap the map again to move the pin.</p>
              <button type="button" disabled={pending} onClick={put} className={`${button} bg-primary text-primary-fg`} data-testid="put-here">{pending ? "Saving…" : "Put them here"}</button>
              <button type="button" onClick={() => setPin(null)} className={`${button} border border-border bg-surface`}>Cancel</button>
            </>
          ) : count ? (
            <>
              <p className="text-sm flex-1"><strong>{count} chosen.</strong> Now tap the map where {count === 1 ? "it was" : "they were"} taken.</p>
              {placedAlready.length > 0 && <button type="button" onClick={() => setFocus(boxOf(placedAlready.map((p) => ({ lat: p.lat!, lng: p.lng! }))))} className={`${button} border border-border bg-surface text-sm`}>Show where now</button>}
              <button type="button" onClick={clear} className={`${button} border border-border bg-surface text-sm`}>Clear</button>
            </>
          ) : (
            <p className="text-sm text-muted">Tap the photos taken in one spot, then tap that spot on the map.</p>
          )}
        </div>
      </div>

      {/* The photographs, a day at a time, the way the trip happened. */}
      <div className="lg:order-1 space-y-5" data-testid="place-list">
        {items.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">{total > items.length ? `The first ${items.length} of ${total}. Search or pick a day to narrow them.` : `${items.length} photo${items.length === 1 ? "" : "s"}.`}</span>
            <button type="button" className="text-primary underline underline-offset-2" onClick={() => setMany(items.map((p) => p.id), true)}>Choose all</button>
            {count > 0 && <button type="button" className="text-primary underline underline-offset-2" onClick={clear}>Choose none</button>}
          </div>
        )}
        {days.map((d) => {
          const ids = d.photos.map((p) => p.id);
          const all = ids.every((id) => selected.has(id));
          return (
            <section key={d.day ?? "undated"} aria-label={d.day ? formatDay(d.day, "weekday") : "No date"}>
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <h3 className="font-display font-semibold">{d.day ? formatDay(d.day, "weekday") : "No date"} <span className="text-sm font-normal text-muted">· {d.photos.length}</span></h3>
                <button type="button" onClick={() => setMany(ids, !all)} className="text-sm text-primary underline underline-offset-2 py-1" data-testid="choose-day">{all ? "Unchoose the day" : "Choose the day"}</button>
              </div>
              <ul className="grid grid-cols-4 sm:grid-cols-5 lg:grid-cols-4 gap-1.5">
                {d.photos.map((p) => {
                  const on = selected.has(p.id);
                  const badge = BADGE[p.by];
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={`${p.label}${p.by === "none" ? ", no place yet" : p.by === "guess" ? `, place guessed${p.guess ? ` as ${p.guess}` : ""}` : ""}`}
                        onClick={() => toggle(p.id)}
                        data-photo={p.id}
                        className={`relative block w-full aspect-square rounded-theme overflow-hidden bg-surface-alt border-2 ${on ? "border-primary" : "border-transparent"}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.thumbUrl} alt="" loading="lazy" className={`w-full h-full object-cover transition ${on ? "scale-90 rounded-theme" : ""}`} />
                        <span aria-hidden className={`absolute top-1 right-1 w-6 h-6 rounded-full border-2 border-white flex items-center justify-center text-xs font-bold shadow ${on ? "bg-primary text-primary-fg" : "bg-black/30"}`}>{on ? "✓" : ""}</span>
                        {badge && <span className={`absolute bottom-1 left-1 rounded px-1 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.text}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
