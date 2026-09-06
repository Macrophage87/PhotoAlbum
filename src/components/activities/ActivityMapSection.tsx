"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActivityType } from "@/generated/prisma/enums";
import type { MapPayload } from "@/lib/map/geojson";
import type { MapTheme } from "@/lib/map/theme";
import { MapViewDynamic } from "@/components/map/MapViewDynamic";
import { TrackCharts } from "@/components/charts/TrackCharts";
import { Lightbox, type LightboxPhoto } from "@/components/photos/Lightbox";

/** Map of one activity's track plus its photos, with charts whose cursor drives a marker on the map. */
export function ActivityMapSection({ tripSlug, trackId, activityId, type, theme, showDetailLink }: { tripSlug: string; trackId: string; activityId: string; type: ActivityType; theme: MapTheme; showDetailLink: boolean }) {
  const [data, setData] = useState<MapPayload | null>(null);
  const [marker, setMarker] = useState<{ lat: number; lng: number } | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/trips/${tripSlug}/geojson`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MapPayload | null) => {
        if (!alive || !d) return;
        const tracks = { ...d.tracks, features: d.tracks.features.filter((f) => f.properties.trackId === trackId) };
        const photos = { ...d.photos, features: d.photos.features.filter((f) => f.properties.activityId === activityId) };
        const t = tracks.features[0];
        let bounds = d.bounds;
        if (t) {
          const c = t.geometry.coordinates;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const [x, y] of c) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          bounds = [[minX, minY], [maxX, maxY]];
        }
        setData({ ...d, tracks, photos, bounds });
      });
    return () => {
      alive = false;
    };
  }, [tripSlug, trackId, activityId]);

  const photos: LightboxPhoto[] = useMemo(() => (data?.photos.features ?? []).map((f) => ({ id: f.properties.id, mediumUrl: f.properties.mediumUrl, width: null, height: null, caption: f.properties.caption, alt: f.properties.caption ?? "Photo" })), [data]);

  return (
    <section className="grid lg:grid-cols-2 gap-4">
      <div className="h-80 lg:h-[26rem] rounded-theme overflow-hidden border border-border">
        {data ? (
          <MapViewDynamic photos={data.photos} tracks={data.tracks} bounds={data.bounds} theme={theme} marker={marker} onPhotoClick={(id) => setLightbox(Math.max(0, photos.findIndex((p) => p.id === id)))} />
        ) : (
          <div className="w-full h-full bg-surface-alt animate-pulse" />
        )}
      </div>
      <div className="rounded-theme border border-border bg-surface p-3">
        <TrackCharts trackId={trackId} type={type} onHover={setMarker} />
      </div>
      {lightbox !== null && photos.length > 0 && <Lightbox photos={photos} index={lightbox} onClose={() => setLightbox(null)} onNavigate={setLightbox} showDetailLink={showDetailLink} />}
    </section>
  );
}
