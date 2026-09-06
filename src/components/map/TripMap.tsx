"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MapPayload, TrackFeatureProps } from "@/lib/map/geojson";
import type { MapTheme } from "@/lib/map/theme";
import { MapViewDynamic } from "./MapViewDynamic";
import { Lightbox, type LightboxPhoto } from "@/components/photos/Lightbox";
import { ACTIVITY_LABEL } from "@/lib/activities/types";
import type { ActivityType } from "@/generated/prisma/enums";
import { ActivityTypeIcon } from "@/components/activities/ActivityTypeIcon";
import { formatDistance } from "@/lib/time/format";

export function TripMap({ src, theme, showDetailLink, showTripList = false }: { src: string; theme: MapTheme; showDetailLink: boolean; showTripList?: boolean }) {
  const [data, setData] = useState<MapPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapPayload["bounds"]>(null);
  const router = useRouter();

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

  const photos: LightboxPhoto[] = useMemo(
    () => (data?.photos.features ?? []).map((f) => ({ id: f.properties.id, mediumUrl: f.properties.mediumUrl, width: null, height: null, caption: f.properties.caption, alt: f.properties.caption ?? "Photo" })),
    [data],
  );
  const tracks = data?.tracks.features ?? [];

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <div className="h-[70vh] bg-surface-alt animate-pulse rounded-theme" />;
  const empty = data.photos.features.length === 0 && data.tracks.features.length === 0;

  return (
    <div className="grid lg:grid-cols-[1fr_18rem] gap-4">
      <div className="h-[70vh] rounded-theme overflow-hidden border border-border relative">
        <MapViewDynamic
          photos={data.photos}
          tracks={data.tracks}
          bounds={data.bounds}
          theme={theme}
          highlightTrackId={hover}
          focusBounds={focus}
          onPhotoClick={(id) => {
            const i = photos.findIndex((p) => p.id === id);
            if (i >= 0) setLightbox(i);
          }}
          onTrackHover={setHover}
          onTrackClick={(p: TrackFeatureProps) => {
            if (p.activityId) router.push(`/trips/${p.tripSlug}/activities/${p.activityId}`);
          }}
        />
        {empty && <div className="absolute inset-x-0 top-3 text-center pointer-events-none"><span className="bg-surface/90 text-muted text-sm px-3 py-1.5 rounded-theme border border-border">No geotagged photos or tracks yet.</span></div>}
      </div>
      <aside className="space-y-4 lg:max-h-[70vh] overflow-y-auto">
        {showTripList && (
          <div>
            <h3 className="text-sm font-medium text-muted mb-2">Trips</h3>
            <ul className="space-y-1">
              {data.trips.map((t) => (
                <li key={t.slug} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`/trips/${t.slug}`} className="hover:underline underline-offset-2 truncate">{t.title}</Link>
                  {t.bounds && <button onClick={() => setFocus(t.bounds)} className="text-xs text-primary hover:underline shrink-0">Show</button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h3 className="text-sm font-medium text-muted mb-2">
            {tracks.length} track{tracks.length === 1 ? "" : "s"} · {photos.length} photo{photos.length === 1 ? "" : "s"}
          </h3>
          <ul className="space-y-1">
            {tracks.map((f) => {
              const p = f.properties;
              const inner = (
                <>
                  {p.activityType ? <ActivityTypeIcon type={p.activityType as ActivityType} className="w-4 h-4 shrink-0" /> : <span className="w-4 h-4 shrink-0 rounded-full border-2 border-dashed" style={{ borderColor: p.color }} />}
                  <span className="truncate">{p.activityTitle ?? p.name}</span>
                  {p.distanceM !== null && p.source !== "GOOGLE" && <span className="ml-auto text-xs text-muted shrink-0">{formatDistance(p.distanceM)}</span>}
                </>
              );
              const cls = `flex items-center gap-2 text-sm rounded px-2 py-1 ${hover === p.trackId ? "bg-surface-alt" : ""}`;
              return (
                <li key={p.trackId} onMouseEnter={() => setHover(p.trackId)} onMouseLeave={() => setHover(null)} title={p.activityType ? ACTIVITY_LABEL[p.activityType as ActivityType] : "Location trace"}>
                  {p.activityId ? <Link href={`/trips/${p.tripSlug}/activities/${p.activityId}`} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
      {lightbox !== null && <Lightbox photos={photos} index={lightbox} onClose={() => setLightbox(null)} onNavigate={setLightbox} showDetailLink={showDetailLink} />}
    </div>
  );
}
