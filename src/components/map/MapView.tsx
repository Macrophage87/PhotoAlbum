"use client";

import { useEffect, useRef, useState } from "react";
import { Map as MLMap, Marker, Popup, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapMouseEvent, type LngLatBoundsLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapTheme } from "@/lib/map/theme";
import type { PhotoFeatureProps, TrackFeatureProps } from "@/lib/map/geojson";
import { basemapStyle } from "./style";

export type MapViewProps = {
  photos: GeoJSON.FeatureCollection<GeoJSON.Point, PhotoFeatureProps>;
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
};

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// The bundler rewrites MapLibre's import.meta.url, so its worker must be served as a static file (see scripts/copy-map-worker.mjs).
if (typeof window !== "undefined") setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

function svgToImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(64, 64);
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  });
}

export function MapView({ photos, tracks, bounds, theme, className = "", onPhotoClick, onTrackClick, onTrackHover, highlightTrackId, marker, focusBounds, interactive = true }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const callbacks = useRef({ onPhotoClick, onTrackClick, onTrackHover });
  useEffect(() => {
    callbacks.current = { onPhotoClick, onTrackClick, onTrackHover };
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
    if (theme.canvasFilter) map.getCanvas().style.filter = theme.canvasFilter;

    map.on("load", async () => {
      try {
        const img = await svgToImage(theme.markerIcon);
        if (!map.hasImage("photo-marker")) map.addImage("photo-marker", img, { pixelRatio: 2 });
      } catch {
        /* marker falls back to a circle layer below */
      }
      map.addSource("tracks", { type: "geojson", data: EMPTY, promoteId: "trackId" });
      map.addSource("photos", { type: "geojson", data: EMPTY, cluster: true, clusterRadius: 48, clusterMaxZoom: 16 });

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

  return <div ref={containerRef} className={`relative w-full h-full ${className}`} />;
}
