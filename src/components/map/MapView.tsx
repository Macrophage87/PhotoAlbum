"use client";

import { useEffect, useRef, useState } from "react";
import { Map as MLMap, Marker, Popup, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapMouseEvent, type LngLatBoundsLike, type ExpressionSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapTheme } from "@/lib/map/theme";
import type { TrackFeatureProps } from "@/lib/map/geojson";
import type { MapPhotoDetail } from "@/lib/map/details";
import type { MapViewport } from "@/lib/map/view";
import { basemapStyle } from "./style";
import { SLOT_COLOURS, SLOT_COUNT } from "@/lib/map/colour-by";
import { formatDay } from "@/lib/time/format";

/**
 * A photograph on the map: its id and the day it was taken, the colour slot of its ring when the map is coloured by
 * something, and its picture and caption where the map was given them up front (the placing screens). A pin without
 * them looks them up with `describe` when it is clicked.
 */
export type MapPhotoProps = { id: string; day: string | null; slot?: number; thumbUrl?: string; caption?: string | null };
/** Photographs the server sent as one group, too many in view to send apiece: how many, the box they fill, and a count per ring slot (`s0`…) as the browser's own groups keep. */
export type MapCellProps = { count: number; label: string; west: number; south: number; east: number; north: number; [slot: `s${number}`]: number };

export type MapViewProps = {
  photos: GeoJSON.FeatureCollection<GeoJSON.Point, MapPhotoProps>;
  /** Photographs already grouped by the server, when there were too many in view to send one by one. */
  cells?: GeoJSON.FeatureCollection<GeoJSON.Point, MapCellProps>;
  /** Looks up what a pin does not carry, for its preview and for the list of a heap of pins. */
  describe?: (ids: string[]) => Promise<ReadonlyMap<string, MapPhotoDetail>>;
  /** The part of the map in view, each time it settles: for a map whose photographs are sent a view at a time. */
  onViewChange?: (view: MapViewport) => void;
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
  /** Each slot's colour, by slot number; the categorical set unless given. */
  slotColours?: readonly string[];
  /** A tap on a photograph's pin is handed straight to `onPhotoClick`, without the preview in between. */
  directPhotoClick?: boolean;
  /** Photographs currently chosen, shown as pressed in the list of a heap of pins (with `directPhotoClick`). */
  pickedIds?: ReadonlySet<string>;
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
function clusterRing(counts: number[], colours: readonly string[]): HTMLElement {
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
      const arc = `<circle cx="${c}" cy="${c}" r="${mid}" fill="none" stroke="${colours[slot]}" stroke-width="${width}" stroke-dasharray="${Math.max(0.5, len - gap)} ${around}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${c} ${c})"/>`;
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

/** A lookup of ring colour by slot number. The spread is too loose for MapLibre's tuple type, and the shape is right. */
function ringColour(colours: readonly string[]): ExpressionSpecification {
  return ["match", ["coalesce", ["get", "slot"], -1], ...colours.flatMap((colour, i) => [i, colour]), "#ffffff"] as unknown as ExpressionSpecification;
}

/** How far from a pin's centre a fingertip still counts as touching it, in screen pixels (a pin is 32 across). */
const TAP_RADIUS = 20;
/** A group that would still be this tight on screen once split is offered as a list instead of zoomed into. */
const STACKED_PX = 40;
/** How many a list of photographs at one spot shows; a bigger group is zoomed into as usual. */
const STACK_LIST_MAX = 60;
const CLUSTER_MAX_ZOOM = 16;

/** Metres per screen pixel at a latitude and zoom (MapLibre's tiles are 512 pixels across). */
function metresPerPixel(lat: number, zoom: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/** How wide a set of points is on the ground, in metres, corner to corner. */
function spanMetres(points: [number, number][]): number {
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dy = (Math.max(...lats) - Math.min(...lats)) * 111_320;
  const dx = (Math.max(...lngs) - Math.min(...lngs)) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** What a picture in the list is called: its caption, or which one it is and the day, so each reads differently. */
function stackLabel(p: MapPhotoProps, i: number, n: number): string {
  // The day where it was taken, never the viewer's own zone.
  const day = p.day ? formatDay(p.day, "long") : null;
  return `${p.caption || `Photo ${i + 1} of ${n}`}${day ? `, ${day}` : ""}`;
}

/** A picture in the list drawn as chosen or not, for a map where tapping chooses. */
function showPicked(b: HTMLElement, on: boolean) {
  b.setAttribute("aria-pressed", String(on));
  b.style.boxShadow = on ? "0 0 0 3px #2563eb" : "none";
  b.style.opacity = on ? "1" : "0.85";
}

/**
 * The photographs at one spot as a list of pictures, each big enough for a finger. Pins on exactly one spot cannot be
 * told apart by tapping — only the top one is ever hit, however far the map is zoomed — so there the map asks which.
 * Where tapping chooses (`picked` given) each shows whether it is chosen, and the list stays open for choosing more.
 */
function stackList(list: MapPhotoProps[], maxHeight: number, pick: (id: string, b: HTMLElement) => void, picked: ReadonlySet<string> | null): HTMLElement {
  const el = document.createElement("div");
  el.dataset.testid = "map-stack";
  const head = document.createElement("div");
  head.style.cssText = "font-size:13px;margin-bottom:6px";
  head.textContent = `${list.length} photos here. ${picked ? "Tap to choose." : "Tap one."}`;
  el.appendChild(head);
  const grid = document.createElement("div");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", `${list.length} photos here`);
  grid.style.cssText = `display:grid;grid-template-columns:repeat(3,64px);gap:6px;padding:3px;max-height:${maxHeight}px;overflow-y:auto`;
  list.forEach((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", stackLabel(p, i, list.length));
    b.dataset.photo = p.id;
    b.style.cssText = "width:64px;height:64px;padding:0;border:0;border-radius:6px;overflow:hidden;cursor:pointer;background:#ddd";
    if (picked) showPicked(b, picked.has(p.id));
    const img = document.createElement("img");
    if (p.thumbUrl) img.src = p.thumbUrl;
    img.alt = "";
    img.loading = "lazy";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
    b.appendChild(img);
    b.onclick = () => pick(p.id, b);
    grid.appendChild(b);
  });
  el.appendChild(grid);
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

export function MapView({ photos, cells, describe, onViewChange, tracks, bounds, theme, className = "", onPhotoClick, onTrackClick, onTrackHover, highlightTrackId, marker, focusBounds, interactive = true, rings = false, slotColours = SLOT_COLOURS, directPhotoClick = false, pickedIds, onMapClick, onDropAt, acceptsDrop }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const hoveredRef = useRef<string | null>(null);
  /** The list of a heap of pins while it is open, so what is chosen can be kept up to date in it. */
  const stackRef = useRef<HTMLElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const callbacks = useRef({ onPhotoClick, onTrackClick, onTrackHover, onMapClick, directPhotoClick, pickedIds, describe, onViewChange });
  useEffect(() => {
    callbacks.current = { onPhotoClick, onTrackClick, onTrackHover, onMapClick, directPhotoClick, pickedIds, describe, onViewChange };
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
      // A tap on a line only belongs to the line where lines do something when tapped; while placing, a photograph
      // taken on the walk belongs exactly on the walk's line, so there the tap goes to the map.
      const layers = callbacks.current.onTrackClick ? ["clusters", "cells", "photo-points", "tracks-line", "tracks-google"] : ["clusters", "cells", "photo-points"];
      const busy = layers.filter((l) => map.getLayer(l));
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
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
        // Each group keeps a count per ring colour, so its ring can be drawn in the shares it holds.
        clusterProperties: Object.fromEntries(Array.from({ length: SLOT_COUNT }, (_, i) => [`s${i}`, ["+", ["case", ["==", ["get", "slot"], i], 1, 0]]])),
      });
      map.addSource("cells", { type: "geojson", data: EMPTY });

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
      // The server's groups, drawn exactly as the browser's own are.
      map.addLayer({
        id: "cells",
        type: "circle",
        source: "cells",
        paint: { "circle-color": theme.clusterColor, "circle-radius": ["step", ["get", "count"], 16, 10, 20, 50, 26], "circle-stroke-width": 3, "circle-stroke-color": "#ffffff", "circle-opacity": 0.9 },
      });
      map.addLayer({
        id: "cell-count",
        type: "symbol",
        source: "cells",
        layout: { "text-field": ["get", "label"], "text-size": 12, "text-font": ["Open Sans Semibold"], "text-allow-overlap": true },
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
          "circle-stroke-color": ringColour(SLOT_COLOURS),
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

      /** What the pins given do not carry, asked twice before giving up: a dropped request should not leave a gray box. */
      const lookUp = (ids: string[]) => {
        const describe = callbacks.current.describe!;
        return describe(ids).catch(() => describe(ids));
      };

      /** Ask which of several photographs at one spot was meant; the answer goes where a tap on its pin would. */
      const chooseFrom = (at: [number, number], list: MapPhotoProps[]) => {
        if (mapRef.current !== map) return; // the map went away while the group was being looked up
        popupRef.current?.remove();
        const choosing = callbacks.current.directPhotoClick && callbacks.current.pickedIds ? callbacks.current.pickedIds : null;
        const pick = (id: string, b: HTMLElement) => {
          // Where tapping chooses, the list stays open so several can be chosen out of one heap; otherwise it has done its job.
          if (choosing) showPicked(b, b.getAttribute("aria-pressed") !== "true");
          else popupRef.current?.remove();
          callbacks.current.onPhotoClick?.(id);
        };
        // Short enough to fit the map it is on, which on a phone is under half the screen.
        const room = Math.min(220, map.getContainer().clientHeight - 80);
        const el = stackList(list, Math.max(72, room), pick, choosing);
        const popup = new Popup({ offset: 14, maxWidth: "260px" }).setLngLat(at).setDOMContent(el);
        // Whether focus is in the list (or on its close button). Removing the popup takes its content out of the page
        // before "close" fires, so by then the browser can no longer say; it is noted as focus comes and goes instead.
        let focusInside = false;
        popup.on("close", () => {
          if (stackRef.current === el) stackRef.current = null;
          // Back to the map, not to the top of the page, for whoever is going by keyboard.
          if (focusInside && mapRef.current === map) map.getCanvas().focus();
        });
        popupRef.current = popup.addTo(map);
        stackRef.current = el;
        const box = popup.getElement();
        box.addEventListener("focusin", () => { focusInside = true; }, true);
        // Focus going somewhere else on the page; a focused button taken out with the popup has nowhere to go (null).
        box.addEventListener("focusout", (e) => { if (e.relatedTarget && !box.contains(e.relatedTarget as Node)) focusInside = false; }, true);
        box.addEventListener("pointerdown", () => { focusInside = focusInside || box.contains(document.activeElement); }, true);
        box.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { e.stopPropagation(); popup.remove(); }
        });
        el.querySelector("button")?.focus({ preventScroll: true });
        // The pictures and captions of pins that came without them, filled in as they arrive.
        const unknown = list.filter((p) => !p.thumbUrl).map((p) => p.id);
        if (unknown.length && callbacks.current.describe) {
          lookUp(unknown)
            .then((found) => {
              el.querySelectorAll<HTMLButtonElement>("button[data-photo]").forEach((b, i) => {
                const d = found.get(b.dataset.photo!);
                if (!d) return;
                b.querySelector("img")!.src = d.thumbUrl;
                b.setAttribute("aria-label", stackLabel({ ...list[i], caption: d.caption }, i, list.length));
              });
            })
            .catch(() => {
              el.firstElementChild!.textContent = `${list.length} photos here. Couldn't load their pictures.`;
            });
        }
      };

      if (interactive) {
        map.on("click", "clusters", (e: MapMouseEvent) => {
          const f = map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
          if (!f) return;
          const src = map.getSource("photos") as GeoJSONSource;
          const at = (f.geometry as GeoJSON.Point).coordinates as [number, number];
          const id = f.properties!.cluster_id as number;
          const count = Number(f.properties!.point_count);
          src
            .getClusterExpansionZoom(id)
            .then(async (zoom: number) => {
              // A group that only splits past the last zoom that groups, and would still be a heap of pins once split,
              // is listed rather than zoomed into: zooming would only show the top pin of the heap.
              if (zoom > CLUSTER_MAX_ZOOM && count <= STACK_LIST_MAX) {
                const leaves = (await src.getClusterLeaves(id, count, 0)) as GeoJSON.Feature<GeoJSON.Point, MapPhotoProps>[];
                const span = spanMetres(leaves.map((l) => l.geometry.coordinates as [number, number]));
                if (span / metresPerPixel(at[1], Math.min(zoom, map.getMaxZoom())) < STACKED_PX) {
                  chooseFrom(at, leaves.map((l) => l.properties));
                  return;
                }
              }
              if (mapRef.current === map) map.easeTo({ center: at, zoom });
            })
            // New data can retire a group between the tap and the answer; the tap then simply does nothing.
            .catch(() => {});
        });
        // A group the server made is zoomed into, by at least a step, until it is sent as single photographs.
        map.on("click", "cells", (e: MapMouseEvent) => {
          const f = map.queryRenderedFeatures(e.point, { layers: ["cells"] })[0];
          if (!f) return;
          const c = f.properties as MapCellProps;
          popupRef.current?.remove();
          const cam = map.cameraForBounds([[c.west, c.south], [c.east, c.north]], { padding: 48, maxZoom: 20 });
          const zoom = Math.min(map.getMaxZoom(), Math.max(cam?.zoom ?? 0, map.getZoom() + 1));
          map.easeTo({ center: cam?.center ?? (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
        });
        map.on("click", "photo-points", (e: MapMouseEvent) => {
          const f = map.queryRenderedFeatures(e.point, { layers: ["photo-points"] })[0];
          if (!f) return;
          const p = f.properties as MapPhotoProps;
          // A fingertip is wider than a pin: every pin centred within TAP_RADIUS of the tap counts as touched too, so
          // pins on top of one another can all be reached. Nearest first, and no more than a list can sensibly hold.
          const r = TAP_RADIUS;
          const near = map
            .queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ["photo-points"] })
            .map((u) => ({ props: u.properties as MapPhotoProps, d: map.project((u.geometry as GeoJSON.Point).coordinates as [number, number]).dist(e.point) }))
            .filter((u) => u.d <= r || u.props.id === p.id)
            .sort((a, b) => a.d - b.d);
          const distinct = [...new Map(near.map((u) => [u.props.id, u.props])).values()].slice(0, STACK_LIST_MAX);
          if (distinct.length > 1) {
            chooseFrom((f.geometry as GeoJSON.Point).coordinates as [number, number], distinct);
            return;
          }
          popupRef.current?.remove();
          if (callbacks.current.directPhotoClick) {
            callbacks.current.onPhotoClick?.(p.id);
            return;
          }
          const el = document.createElement("div");
          el.className = "cursor-pointer";
          el.dataset.testid = "map-preview";
          const img = document.createElement("img");
          if (p.thumbUrl) img.src = p.thumbUrl;
          img.alt = "";
          img.style.cssText = "width:160px;height:120px;object-fit:cover;border-radius:6px;display:block;background:#ddd";
          el.appendChild(img);
          const cap = document.createElement("div");
          cap.style.cssText = "max-width:160px;font-size:12px;margin-top:4px";
          cap.textContent = p.caption ?? "";
          el.appendChild(cap);
          // A pin sent without its picture asks for it now, with the caption, the activity and (for members) who uploaded it.
          if (!p.thumbUrl && callbacks.current.describe) {
            lookUp([p.id])
              .then((found) => {
                const d = found.get(p.id);
                if (!d) {
                  cap.textContent = "This photo is no longer available.";
                  return;
                }
                img.src = d.thumbUrl;
                cap.textContent = d.caption ?? "";
                const about = [d.activityTitle, d.uploadedBy ? `Uploaded by ${d.uploadedBy}` : null].filter(Boolean).join(" · ");
                if (about) {
                  const more = document.createElement("div");
                  more.style.cssText = "max-width:160px;font-size:11px;margin-top:2px;opacity:.7";
                  more.textContent = about;
                  el.appendChild(more);
                }
              })
              .catch(() => {
                cap.textContent = "Couldn't load this photo.";
              });
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
        for (const layer of ["clusters", "cells", "photo-points"]) {
          map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
          map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
        }
      }
      // Where the map is looking, once it settles: when it opens and after every move.
      const report = () => {
        const b = map.getBounds();
        callbacks.current.onViewChange?.({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(), zoom: map.getZoom() });
      };
      map.on("moveend", report);
      setLoaded(true);
      report();
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
    (map.getSource("cells") as GeoJSONSource | undefined)?.setData(cells ?? EMPTY);
  }, [photos, cells, tracks, loaded]);

  // Rings: a layer for single photographs, and for each group on screen a ring of its own drawn over the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    map.setLayoutProperty("photo-rings", "visibility", rings ? "visible" : "none");
    map.setPaintProperty("photo-rings", "circle-stroke-color", ringColour(slotColours));
    map.setPaintProperty("clusters", "circle-stroke-width", rings ? 0 : 3);
    map.setPaintProperty("cells", "circle-stroke-width", rings ? 0 : 3);
    if (!rings) return;
    // Keyed by the group and what is in it: the same photographs coloured another way make groups with the same ids,
    // and a ring kept by id alone would go on showing the old colours. The rings outlive new data (a map sent a view
    // at a time gets new data on every move): each is swapped for its successor once the new groups are drawn, rather
    // than all taken down at once and the map left without rings until then.
    const drawn = new Map<string, Marker>();
    const update = () => {
      if (!map.getSource("photos") || !map.isSourceLoaded("photos") || !map.isSourceLoaded("cells")) return;
      const seen = new Set<string>();
      // The browser's groups and the server's, which carry their counts per slot the same way.
      const groups = [
        ...map.querySourceFeatures("photos").filter((f) => f.properties?.cluster).map((f) => ({ f, id: `g${f.properties!.cluster_id}` })),
        ...map.querySourceFeatures("cells").map((f) => ({ f, id: `c${f.properties?.west},${f.properties?.south}` })),
      ];
      for (const { f, id } of groups) {
        const props = f.properties as Record<string, number>;
        const counts = Array.from({ length: SLOT_COUNT }, (_, i) => Number(props[`s${i}`] ?? 0));
        const at = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        // Where it is too: new data can give a group elsewhere the id and counts an old one had.
        const key = `${id}@${at[0].toFixed(5)},${at[1].toFixed(5)}:${counts.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!drawn.has(key)) {
          const m = new Marker({ element: clusterRing(counts, slotColours) }).setLngLat(at).addTo(map);
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
    // New data renumbers the groups, which `update` sees on the next frame drawn; only another way of colouring starts afresh.
  }, [rings, loaded, slotColours]);

  // What is chosen, kept up to date in an open list of a heap of pins.
  useEffect(() => {
    const el = stackRef.current;
    if (!el || !pickedIds || !directPhotoClick) return;
    for (const b of el.querySelectorAll<HTMLElement>("button[data-photo]")) showPicked(b, pickedIds.has(b.dataset.photo!));
  }, [pickedIds, directPhotoClick]);

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
