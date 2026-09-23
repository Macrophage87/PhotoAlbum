"use client";

import { useEffect, useRef, useState } from "react";
import { Map as MLMap, Marker, Popup, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapMouseEvent, type LngLatBoundsLike, type ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapTheme } from "@/lib/map/theme";
import type { PhotoFeatureProps, TrackFeatureProps } from "@/lib/map/geojson";
import { basemapStyle } from "./style";
import { SLOT_COLOURS } from "@/lib/map/colour-by";

/** A photograph on the map, with the colour slot of its ring when the map is coloured by something. */
export type MapPhotoProps = PhotoFeatureProps & { slot?: number };

export type MapViewProps = {
  photos: GeoJSON.FeatureCollection<GeoJSON.Point, MapPhotoProps>;
  tracks: GeoJSON.FeatureCollection<GeoJSON.LineString, TrackFeatureProps>;
  bounds: [[number, number], [number, number]] | null;
  theme: MapTheme;
  className?: string;
  onPhotoClick?: (id: string) => void;
  onTrackClick?: (props: TrackFeatureProps) => void;
  onTrackHover?: (trackId: string | null) => void;
  /** Externally highlighted track (e.g. from a list hover). */
  highlightTrackId?: string | null;
  /** A point to mark, e.g. the chart cursor position. */
  marker?: { lat: number; lng: number } | null;
  /** Bounds to fly to when they change (e.g. a trip picked from a list). */
  focusBounds?: [[number, number], [number, number]] | null;
  interactive?: boolean;
  /** Ring every photograph, and every group of them, in the colour of its `slot`. */
  rings?: boolean;
  /** A tap on a photograph's pin is handed straight to `onPhotoClick`, without the preview in between. */
  directPhotoClick?: boolean;
  /** A click on the map itself (not on a photo or track), for placing things. */
  onMapClick?: (pos: { lat: number; lng: number }) => void;
  /** Something dropped on the map, with the spot it landed on. Nothing is dropped unless `acceptsDrop` says so. */
  onDropAt?: (pos: { lat: number; lng: number }, e: React.DragEvent) => void;
  /** Whether a hovering drag is one this map wants, decided without reading data the browser will not give yet. */
  acceptsDrop?: (e: React.DragEvent) => boolean;
};

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// The bundler rewrites MapLibre's import.meta.url, so its worker must be served as a static file (see scripts/copy-map-worker.mjs).
if (typeof window !== "undefined") setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

/** The radius of a group's circle for how many photographs are in it; the same steps the circle layer uses. */
function clusterRadius(count: number): number {
  return count < 10 ? 16 : count < 50 ? 20 : 26;
}

/**
 * The ring round a group of photographs: one arc per colour, as long as that colour's share of the group, with a
 * hairline of white between arcs so neighbouring colours do not run together. The middle is left empty, so the
 * group's own circle and count show through it.
 */
function clusterRing(counts: number[]): HTMLElement {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const r = clusterRadius(total);
  const width = 6;
  const mid = r + width / 2 - 1;
  const size = 2 * (r + width + 1);
  const c = size / 2;
  const around = 2 * Math.PI * mid;
  const parts = counts.map((n, slot) => ({ n, slot })).filter((p) => p.n > 0);
  const gap = parts.length > 1 ? 1.5 : 0;
  let offset = 0;
  const arcs = parts
    .map(({ n, slot }) => {
      const len = (n / total) * around;
      const arc = `<circle cx="${c}" cy="${c}" r="${mid}" fill="none" stroke="${SLOT_COLOURS[slot]}" stroke-width="${width}" stroke-dasharray="${Math.max(0.5, len - gap)} ${around}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${c} ${c})"/>`;
      offset += len;
      return arc;
    })
    .join("");
  const el = document.createElement("div");
  // Clicks go through the ring to the group underneath, which already knows how to open itself.
  el.style.cssText = `width:${size}px;height:${size}px;pointer-events:none`;
  el.dataset.ring = parts.map((p) => `${p.slot}:${p.n}`).join(",");
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${c}" cy="${c}" r="${r + width}" fill="none" stroke="#fff" stroke-width="1.5"/>${arcs}</svg>`;
  return el;
}

function svgToImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(64, 64);
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  });
}

export function MapView({ photos, tracks, bounds, theme, className = "", onPhotoClick, onTrackClick, onTrackHover, highlightTrackId, marker, focusBounds, interactive = true, rings = false, directPhotoClick = false, onMapClick, onDropAt, acceptsDrop }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const callbacks = useRef({ onPhotoClick, onTrackClick, onTrackHover, onMapClick, directPhotoClick });
  useEffect(() => {
    callbacks.current = { onPhotoClick, onTrackClick, onTrackHover, onMapClick, directPhotoClick };
  });

  // Create the map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MLMap({
      container: containerRef.current,
      style: basemapStyle(),
      bounds: (bounds as LngLatBoundsLike | null) ?? undefined,
      fitBoundsOptions: { padding: 48, maxZoom: 15 },
      center: bounds ? undefined : [-98, 39],
      zoom: bounds ? undefined : 3,
      interactive,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    (containerRef.current as HTMLDivElement & { __map?: MLMap }).__map = map; // handy for debugging in devtools
    if (interactive) map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.on("click", (e: MapMouseEvent) => {
      if (!callbacks.current.onMapClick) return;
      const busy = ["clusters", "photo-points", "tracks-line", "tracks-google"].filter((l) => map.getLayer(l));
      if (busy.length && map.queryRenderedFeatures(e.point, { layers: busy }).length) return;
      callbacks.current.onMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    if (theme.canvasFilter) map.getCanvas().style.filter = theme.canvasFilter;

    map.on("load", async () => {
      try {
        const img = await svgToImage(theme.markerIcon);
        if (!map.hasImage("photo-marker")) map.addImage("photo-marker", img, { pixelRatio: 2 });
      } catch {
        /* marker falls back to a circle layer below */
      }
      map.addSource("tracks", { type: "geojson", data: EMPTY, promoteId: "trackId" });
      map.addSource("photos", {
        type: "geojson",
        data: EMPTY,
        cluster: true,
        clusterRadius: 48,
        clusterMaxZoom: 16,
        // Each group keeps a count per ring colour, so its ring can be drawn in the shares it holds.
        clusterProperties: Object.fromEntries(SLOT_COLOURS.map((_, i) => [`s${i}`, ["+", ["case", ["==", ["get", "slot"], i], 1, 0]]])),
      });

      map.addLayer({
        id: "tracks-google",
        type: "line",
        source: "tracks",
        filter: ["==", ["get", "source"], "GOOGLE"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 4, 2], "line-opacity": 0.6, "line-dasharray": [2, 2] },
      });
      map.addLayer({
        id: "tracks-casing",
        type: "line",
        source: "tracks",
        filter: ["!=", ["get", "source"], "GOOGLE"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 9, 6], "line-opacity": 0.8 },
      });
      map.addLayer({
        id: "tracks-line",
        type: "line",
        source: "tracks",
        filter: ["!=", ["get", "source"], "GOOGLE"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 6, 3.5] },
      });
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "photos",
        filter: ["has", "point_count"],
        paint: { "circle-color": theme.clusterColor, "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 50, 26], "circle-stroke-width": 3, "circle-stroke-color": "#ffffff", "circle-opacity": 0.9 },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "photos",
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": ["Open Sans Semibold"], "text-allow-overlap": true },
        paint: { "text-color": "#ffffff" },
      });
      // The ring round a single photograph: under its marker, so the trip's own marker still says whose map this is.
      map.addLayer({
        id: "photo-rings",
        type: "circle",
        source: "photos",
        filter: ["!", ["has", "point_count"]],
        layout: { visibility: "none" },
        paint: {
          "circle-radius": 17,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 4.5,
          // A lookup by slot number; the spread is too loose for MapLibre's tuple type, and the shape is right.
          "circle-stroke-color": ["match", ["coalesce", ["get", "slot"], -1], ...SLOT_COLOURS.flatMap((colour, i) => [i, colour]), "#ffffff"] as unknown as ExpressionSpecification,
        },
      });
      if (map.hasImage("photo-marker")) {
        map.addLayer({
          id: "photo-points",
          type: "symbol",
          source: "photos",
          filter: ["!", ["has", "point_count"]],
          layout: { "icon-image": "photo-marker", "icon-size": 1, "icon-allow-overlap": true, "icon-anchor": "center" },
        });
      } else {
        map.addLayer({
          id: "photo-points",
          type: "circle",
          source: "photos",
          filter: ["!", ["has", "point_count"]],
          paint: { "circle-color": theme.photoMarkerColor, "circle-radius": 7, "circle-stroke-width": 2.5, "circle-stroke-color": "#ffffff" },
        });
      }

      const setHover = (id: string | null) => {
        if (hoveredRef.current && hoveredRef.current !== id) map.setFeatureState({ source: "tracks", id: hoveredRef.current }, { hover: false });
        if (id) map.setFeatureState({ source: "tracks", id }, { hover: true });
        hoveredRef.current = id;
      };

      if (interactive) {
        map.on("click", "clusters", (e: MapMouseEvent) => {
          const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
          if (!f) return;
          const src = map.getSource("photos") as GeoJSONSource;
          src.getClusterExpansionZoom(f.properties!.cluster_id as number).then((zoom: number) => {
            map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
          });
        });
        map.on("click", "photo-points", (e: MapMouseEvent) => {
          const f = map.queryRenderedFeatures(e.point, { layers: ["photo-points"] })[0];
          if (!f) return;
          const p = f.properties as PhotoFeatureProps;
          popupRef.current?.remove();
          if (callbacks.current.directPhotoClick) {
            callbacks.current.onPhotoClick?.(p.id);
            return;
          }
          const el = document.createElement("div");
          el.className = "cursor-pointer";
          const img = document.createElement("img");
          img.src = p.thumbUrl;
          img.alt = "";
          img.style.cssText = "width:160px;height:120px;object-fit:cover;border-radius:6px;display:block";
          el.appendChild(img);
          if (p.caption) {
            const cap = document.createElement("div");
            cap.style.cssText = "max-width:160px;font-size:12px;margin-top:4px";
            cap.textContent = p.caption;
            el.appendChild(cap);
          }
          el.onclick = () => callbacks.current.onPhotoClick?.(p.id);
          popupRef.current = new Popup({ offset: 14, closeButton: false, maxWidth: "200px" }).setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).setDOMContent(el).addTo(map);
        });
        for (const layer of ["tracks-line", "tracks-google"]) {
          map.on("mousemove", layer, (e: MapMouseEvent) => {
            const f = map.queryRenderedFeatures(e.point, { layers: [layer] })[0];
            if (!f) return;
            const id = String(f.id ?? (f.properties as TrackFeatureProps).trackId);
            if (hoveredRef.current !== id) {
              setHover(id);
              callbacks.current.onTrackHover?.(id);
            }
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", layer, () => {
            setHover(null);
            callbacks.current.onTrackHover?.(null);
            map.getCanvas().style.cursor = "";
          });
          map.on("click", layer, (e: MapMouseEvent) => {
            const f = map.queryRenderedFeatures(e.point, { layers: [layer] })[0];
            if (f) callbacks.current.onTrackClick?.(f.properties as TrackFeatureProps);
          });
        }
        for (const layer of ["clusters", "photo-points"]) {
          map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
          map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
        }
      }
      setLoaded(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setLoaded(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Data updates
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource("tracks") as GeoJSONSource | undefined)?.setData(tracks);
    (map.getSource("photos") as GeoJSONSource | undefined)?.setData(photos);
  }, [photos, tracks, loaded]);

  // Rings: a layer for single photographs, and for each group on screen a ring of its own drawn over the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    map.setLayoutProperty("photo-rings", "visibility", rings ? "visible" : "none");
    map.setPaintProperty("clusters", "circle-stroke-width", rings ? 0 : 3);
    if (!rings) return;
    // Keyed by the group and what is in it: the same photographs coloured another way make groups with the same ids,
    // and a ring kept by id alone would go on showing the old colours.
    const drawn = new Map<string, Marker>();
    const update = () => {
      if (!map.getSource("photos") || !map.isSourceLoaded("photos")) return;
      const seen = new Set<string>();
      for (const f of map.querySourceFeatures("photos")) {
        const props = f.properties as Record<string, number> | null;
        if (!props?.cluster) continue;
        const counts = SLOT_COLOURS.map((_, i) => Number(props[`s${i}`] ?? 0));
        const key = `${props.cluster_id}:${counts.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!drawn.has(key)) {
          const m = new Marker({ element: clusterRing(counts) }).setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).addTo(map);
          drawn.set(key, m);
        }
      }
      for (const [id, m] of drawn) {
        if (!seen.has(id)) {
          m.remove();
          drawn.delete(id);
        }
      }
    };
    map.on("render", update);
    update();
    return () => {
      map.off("render", update);
      for (const m of drawn.values()) m.remove();
    };
    // New data renumbers the groups, so the rings are drawn afresh whenever the photographs change.
  }, [rings, photos, loaded]);

  // External highlight
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    if (hoveredRef.current && hoveredRef.current !== highlightTrackId) map.setFeatureState({ source: "tracks", id: hoveredRef.current }, { hover: false });
    if (highlightTrackId) map.setFeatureState({ source: "tracks", id: highlightTrackId }, { hover: true });
    hoveredRef.current = highlightTrackId ?? null;
  }, [highlightTrackId, loaded]);

  // Cursor marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!marker) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const el = document.createElement("div");
      el.style.cssText = `width:14px;height:14px;border-radius:50%;background:${theme.photoMarkerColor};border:3px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.25)`;
      markerRef.current = new Marker({ element: el }).setLngLat([marker.lng, marker.lat]).addTo(map);
    } else markerRef.current.setLngLat([marker.lng, marker.lat]);
  }, [marker, theme.photoMarkerColor]);

  // Focus
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusBounds) return;
    map.fitBounds(focusBounds as LngLatBoundsLike, { padding: 48, maxZoom: 15, duration: 800 });
  }, [focusBounds]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full ${className}`}
      // A photograph dropped on the map is placed where it landed: the map turns the point on the screen back into
      // a position on the ground, which is the one thing only the map itself can do.
      onDragOver={onDropAt && acceptsDrop ? (e) => { if (acceptsDrop(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } } : undefined}
      onDrop={onDropAt && acceptsDrop
        ? (e) => {
            if (!acceptsDrop(e) || !mapRef.current || !containerRef.current) return;
            e.preventDefault();
            const rect = containerRef.current.getBoundingClientRect();
            const at = mapRef.current.unproject([e.clientX - rect.left, e.clientY - rect.top]);
            onDropAt({ lat: at.lat, lng: at.lng }, e);
          }
        : undefined}
    />
  );
}
