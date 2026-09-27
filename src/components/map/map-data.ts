"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapPayload, MapPhotos, PhotoCell, PhotoPoint } from "@/lib/map/geojson";
import type { MapPhotoDetail } from "@/lib/map/details";
import type { ColourBy } from "@/lib/map/colour-by";
import { MAX_DESCRIBED, type MapViewport } from "@/lib/map/view";
import type { MapCellProps, MapPhotoProps } from "./MapView";
import { viewAsker } from "./view-asker";

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

/**
 * A map's data: everything but its photographs once, and the photographs too when the map is small enough to send
 * them at once. A bigger map sends its photographs a view at a time, asked for as the map settles (`onViewChange`,
 * see `viewAsker`). Each answer says which legends its ring slots are numbered by; when the album has changed since
 * the map opened and they are new ones, the map's legends and tracks are asked for again to match.
 */
export function useMapData(src: string) {
  const [data, setData] = useState<MapPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inView, setInView] = useState<{ src: string; photos: MapPhotos } | null>(null);
  /** Bumped to ask for the map's legends and tracks again. */
  const [reload, setReload] = useState(0);
  const version = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(src)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Map data failed (${r.status})`))))
      .then((d: MapPayload) => {
        if (!alive) return;
        version.current = d.version;
        setData(d);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [src, reload]);

  const asker = useRef<ReturnType<typeof viewAsker> | null>(null);
  useEffect(() => {
    const mine = viewAsker({
      fetchView: (v, signal) =>
        fetch(`${src}${src.includes("?") ? "&" : "?"}bbox=${[v.west, v.south, v.east, v.north].map((n) => n.toFixed(5)).join(",")}&zoom=${v.zoom.toFixed(2)}`, { signal }).then((r) =>
          r.ok ? (r.json() as Promise<MapPhotos>) : Promise.reject(new Error(String(r.status))),
        ),
      onAnswer: (photos) => {
        setInView({ src, photos });
        if (version.current !== null && photos.version !== version.current) {
          version.current = photos.version;
          setReload((n) => n + 1);
        }
      },
    });
    asker.current = mine;
    return () => {
      mine.dispose();
      if (asker.current === mine) asker.current = null;
    };
  }, [src]);

  const onViewChange = useCallback(
    (v: MapViewport) => {
      if (data && !data.photos.complete) asker.current?.ask(v);
    },
    [data],
  );
  /** Ask for the view on screen again, now: something on it was just changed. False when the map is sent whole. */
  const refresh = useCallback(() => (data && !data.photos.complete && asker.current ? asker.current.refresh() : Promise.resolve(false)), [data]);

  const photos = data ? (data.photos.complete ? data.photos : inView?.src === src ? inView.photos : null) : null;
  return { data, error, photos, onViewChange, refresh };
}

/**
 * The details a pin does not carry (its picture, caption, activity and uploader), looked up when it is clicked and
 * kept for the visit. A share page's map asks as its visitors do (`view=share`). The answer holds only what this
 * viewer may see; a request that fails rejects.
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
        // A failed request is not an answer: nothing is taken to be gone because the network was.
        if (!r.ok) throw new Error(`Photo details failed (${r.status})`);
        for (const d of ((await r.json()) as { photos: MapPhotoDetail[] }).photos) cache.current.set(d.id, d);
      }
      if (missing.length) setKnown(new Map(cache.current));
      return new Map(ids.flatMap((id) => (cache.current.has(id) ? [[id, cache.current.get(id)!] as const] : [])));
    },
    [view],
  );
  return { describe, known };
}
