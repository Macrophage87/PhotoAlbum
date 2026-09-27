"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapPayload, MapPhotos, PhotoCell, PhotoPoint } from "@/lib/map/geojson";
import type { MapPhotoDetail } from "@/lib/map/details";
import type { ColourBy } from "@/lib/map/colour-by";
import { MAX_DESCRIBED, type MapViewport } from "@/lib/map/view";
import type { MapCellProps, MapPhotoProps } from "./MapView";

/** Where each way of colouring keeps its slot in a sent photograph. */
const SLOT_AT = { day: 4, activity: 5, uploader: 6 } as const;

/** The photographs as pins, each with its ring slot for the way the map is coloured. */
export function pointFeatures(points: PhotoPoint[], by: ColourBy): GeoJSON.FeatureCollection<GeoJSON.Point, MapPhotoProps> {
  const at = by === "none" ? null : SLOT_AT[by];
  return {
    type: "FeatureCollection",
    features: points.map((p) => {
      const slot = at === null ? null : p[at];
      return { type: "Feature", geometry: { type: "Point", coordinates: [p[1], p[2]] }, properties: slot === null ? { id: p[0], day: p[3] } : { id: p[0], day: p[3], slot } };
    }),
  };
}

/** "1.2k", as MapLibre labels its own groups. */
const abbreviated = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The groups the server made, with a count per ring slot for the way the map is coloured, as the browser's own groups have. */
export function cellFeatures(cells: PhotoCell[], by: ColourBy): GeoJSON.FeatureCollection<GeoJSON.Point, MapCellProps> {
  return {
    type: "FeatureCollection",
    features: cells.map((c) => {
      const counts: Record<string, number> = {};
      const pairs = by === "none" ? [] : (c.rings[by] ?? []);
      for (let i = 0; i < pairs.length; i += 2) counts[`s${pairs[i]}`] = pairs[i + 1];
      const [west, south, east, north] = c.box;
      return { type: "Feature", geometry: { type: "Point", coordinates: c.at }, properties: { count: c.n, label: abbreviated(c.n), west, south, east, north, ...counts } };
    }),
  };
}

/** A view made half as wide again on every side, so a small pan stays inside what was already sent. */
function widen(v: MapViewport): MapViewport {
  const w = v.east - v.west;
  const h = v.north - v.south;
  const wide = w * 2 >= 360;
  return { west: wide ? -180 : v.west - w / 2, east: wide ? 180 : v.east + w / 2, south: Math.max(-90, v.south - h / 2), north: Math.min(90, v.north + h / 2), zoom: v.zoom };
}

const covers = (a: MapViewport, b: MapViewport) => a.west <= b.west && a.east >= b.east && a.south <= b.south && a.north >= b.north;

/**
 * A map's data: everything but its photographs once, and the photographs too when the map is small enough to send
 * them at once. A bigger map sends its photographs a view at a time, asked for as the map settles (`onViewChange`)
 * and only when what is on screen was not already sent: a view of single photographs stays good anywhere inside it,
 * and a view of groups until the zoom changes, since groups are only right for the zoom they were made for.
 */
export function useMapData(src: string) {
  const [data, setData] = useState<MapPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inView, setInView] = useState<{ src: string; photos: MapPhotos } | null>(null);
  const asked = useRef<{ src: string; view: MapViewport; grouped: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(src)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Map data failed (${r.status})`))))
      .then((d: MapPayload) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [src]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      pending.current?.abort();
    },
    [],
  );

  const onViewChange = useCallback(
    (v: MapViewport) => {
      if (!data || data.photos.complete) return;
      const last = asked.current;
      if (last && last.src === src && covers(last.view, v) && (!last.grouped || Math.floor(last.view.zoom) === Math.floor(v.zoom))) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        pending.current?.abort();
        const ctl = new AbortController();
        pending.current = ctl;
        const wide = widen(v);
        const bbox = [wide.west, wide.south, wide.east, wide.north].map((n) => n.toFixed(5)).join(",");
        fetch(`${src}${src.includes("?") ? "&" : "?"}bbox=${bbox}&zoom=${v.zoom.toFixed(2)}`, { signal: ctl.signal })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((photos: MapPhotos) => {
            asked.current = { src, view: wide, grouped: photos.cells.length > 0 };
            setInView({ src, photos });
          })
          // Given up for a newer view, or failed: the map keeps what it has, and the next move asks again.
          .catch(() => {});
      }, 250);
    },
    [data, src],
  );

  const photos = data ? (data.photos.complete ? data.photos : inView?.src === src ? inView.photos : null) : null;
  return { data, error, photos, onViewChange };
}

/**
 * The details a pin does not carry (its picture, caption, activity and uploader), looked up when it is clicked and
 * kept for the visit. A share page's map asks as its visitors do (`view=share`).
 */
export function useDescribe(src: string) {
  const view = useMemo(() => new URL(src, "http://localhost").searchParams.get("view"), [src]);
  const cache = useRef(new Map<string, MapPhotoDetail>());
  const [known, setKnown] = useState<ReadonlyMap<string, MapPhotoDetail>>(new Map());
  const describe = useCallback(
    async (ids: string[]): Promise<ReadonlyMap<string, MapPhotoDetail>> => {
      const missing = [...new Set(ids)].filter((id) => !cache.current.has(id));
      for (let i = 0; i < missing.length; i += MAX_DESCRIBED) {
        const q = new URLSearchParams({ ids: missing.slice(i, i + MAX_DESCRIBED).join(",") });
        if (view) q.set("view", view);
        const r = await fetch(`/api/map/photos?${q}`);
        if (!r.ok) continue;
        for (const d of ((await r.json()) as { photos: MapPhotoDetail[] }).photos) cache.current.set(d.id, d);
      }
      if (missing.length) setKnown(new Map(cache.current));
      return new Map(ids.flatMap((id) => (cache.current.has(id) ? [[id, cache.current.get(id)!] as const] : [])));
    },
    [view],
  );
  return { describe, known };
}
