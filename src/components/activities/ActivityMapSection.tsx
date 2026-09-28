"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActivityType } from "@/generated/prisma/enums";
import type { ActivityMapPayload } from "@/lib/map/geojson";
import type { MapTheme } from "@/lib/map/theme";
import { MapViewDynamic } from "@/components/map/MapViewDynamic";
import { TrackCharts } from "@/components/charts/TrackCharts";
import { Lightbox, type LightboxPhoto } from "@/components/photos/Lightbox";

/**
 * Map of one activity's track plus its photos, with charts whose cursor drives a marker on the map. It asks for the
 * activity alone rather than the whole trip, so the same section works for whoever holds only the activity's link.
 */
export function ActivityMapSection({ trackId, activityId, type, theme, member = false }: { trackId: string; activityId: string; type: ActivityType; theme: MapTheme; /** A member on a member's page; otherwise the map is asked for as the page's visitors see it (`view=share`). */ member?: boolean }) {
  const [data, setData] = useState<ActivityMapPayload | null>(null);
  const [marker, setMarker] = useState<{ lat: number; lng: number } | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/activities/${activityId}/geojson${member ? "" : "?view=share"}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ActivityMapPayload | null) => {
        if (alive && d) setData(d);
      });
    return () => {
      alive = false;
    };
  }, [activityId, member]);

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
      {lightbox !== null && photos.length > 0 && <Lightbox photos={photos} index={lightbox} onClose={() => setLightbox(null)} onNavigate={setLightbox} />}
    </section>
  );
}
