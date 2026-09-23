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
import { ringsFor, SLOT_COLOURS, type ColourBy } from "@/lib/map/colour-by";

const COLOUR_BY_KEY = "map-colour-by";
const COLOUR_BY_LABEL: Record<ColourBy, string> = { none: "Nothing", day: "Day", activity: "Activity", uploader: "Who uploaded" };

export function TripMap({ src, theme, showTripList = false, activityHrefBase, narrowed = false }: { src: string; theme: MapTheme; showTripList?: boolean; /** Override the activity link root, e.g. for share pages. */ activityHrefBase?: string; /** Something is being looked for, so an empty map means "no match" rather than "nothing placed yet". */ narrowed?: boolean }) {
  const activityHref = (tripSlug: string, activityId: string) => `${activityHrefBase ?? `/trips/${tripSlug}/activities`}/${activityId}`;
  const [data, setData] = useState<MapPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<MapPayload["bounds"]>(null);
  // The choice is remembered on this device, so somebody who likes seeing the days keeps seeing them. Read as the
  // state starts rather than after: nothing it affects is drawn until the map's data has arrived, well after hydration.
  const [colourBy, setColourBy] = useState<ColourBy>(() => {
    try {
      const kept = typeof window === "undefined" ? null : localStorage.getItem(COLOUR_BY_KEY);
      return kept === "day" || kept === "activity" || kept === "uploader" ? kept : "none";
    } catch {
      return "none";
    }
  });
  const router = useRouter();

  const chooseColourBy = (value: ColourBy) => {
    setColourBy(value);
    try {
      localStorage.setItem(COLOUR_BY_KEY, value);
    } catch {
      /* not remembered, still applied */
    }
  };

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
  // Who uploaded what is for members only; the server leaves it out for anybody else, and then so does the choice.
  const canByUploader = useMemo(() => (data?.photos.features ?? []).some((f) => f.properties.uploaderId), [data]);
  const by: ColourBy = colourBy === "uploader" && !canByUploader ? "none" : colourBy;
  const coloured = useMemo(() => {
    if (!data || by === "none") return null;
    const rings = ringsFor(by, data.photos.features.map((f) => f.properties), data.tracks.features.map((f) => f.properties));
    return {
      groups: rings.groups,
      photos: { ...data.photos, features: data.photos.features.map((f) => ({ ...f, properties: { ...f.properties, slot: rings.photoSlot(f.properties) } })) },
      // A track takes the colour of what it belongs to, so a walk and the photographs along it match.
      tracks: { ...data.tracks, features: data.tracks.features.map((f) => ({ ...f, properties: { ...f.properties, color: SLOT_COLOURS[rings.trackSlot(f.properties)] } })) },
    };
  }, [data, by]);
  const tracks = (coloured?.tracks ?? data?.tracks)?.features ?? [];

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <div className="h-[70vh] bg-surface-alt animate-pulse rounded-theme" />;
  const empty = data.photos.features.length === 0 && data.tracks.features.length === 0;

  return (
    <div className="grid lg:grid-cols-[1fr_18rem] gap-4">
      <div className="h-[70vh] rounded-theme overflow-hidden border border-border relative">
        <MapViewDynamic
          photos={coloured?.photos ?? data.photos}
          tracks={coloured?.tracks ?? data.tracks}
          rings={Boolean(coloured)}
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
            if (p.activityId) router.push(activityHref(p.tripSlug, p.activityId));
          }}
        />
        {empty && (
          <div className="absolute inset-x-0 top-3 px-3 text-center pointer-events-none">
            <span className="inline-block max-w-md bg-surface/90 text-muted text-sm px-3 py-1.5 rounded-theme border border-border" data-testid={narrowed ? "map-no-matches" : "map-empty"}>
              {narrowed
                ? "Nothing with a place on it matches that. A photograph is only on the map once it has somewhere to be."
                : "Nothing to put on the map here yet. A photo gets its place from the camera, from a track covering the moment it was taken, or from one a family member sets by hand."}
            </span>
          </div>
        )}
      </div>
      <aside className="space-y-4 lg:max-h-[70vh] overflow-y-auto">
        {data.photos.features.length > 0 && (
          <div data-testid="map-colour-by">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Color by</span>
              <select value={by} onChange={(e) => chooseColourBy(e.target.value as ColourBy)} className="flex-1 rounded-theme border border-border bg-surface px-2 py-1">
                {(["none", "day", "activity", ...(canByUploader ? (["uploader"] as const) : [])] as ColourBy[]).map((v) => (
                  <option key={v} value={v}>{COLOUR_BY_LABEL[v]}</option>
                ))}
              </select>
            </label>
            {coloured && (
              <ul className="mt-2 space-y-1" data-testid="map-legend">
                {coloured.groups.map((g) => (
                  <li key={g.slot} className="flex items-center gap-2 text-sm" data-slot={g.slot}>
                    <span aria-hidden className="w-3.5 h-3.5 shrink-0 rounded-full border-[3px]" style={{ borderColor: SLOT_COLOURS[g.slot] }} />
                    <span className="truncate">{g.label}</span>
                    <span className="ml-auto text-xs text-muted shrink-0">{g.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
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
          <h3 className="text-sm font-medium text-muted mb-2" data-testid="map-count">
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
                  {p.activityId ? <Link href={activityHref(p.tripSlug, p.activityId)} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
      {lightbox !== null && <Lightbox photos={photos} index={lightbox} onClose={() => setLightbox(null)} onNavigate={setLightbox} />}
    </div>
  );
}
