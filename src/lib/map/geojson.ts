import { db } from "@/lib/db";
import type { Viewer } from "@/lib/auth/viewer";
import { visibleTripsWhere } from "@/lib/auth/access";
import { photoUrl } from "@/lib/photos/urls";
import { mergeBounds, type Bounds } from "@/lib/geo/bounds";
import { getTheme } from "@/themes";
import { ACTIVITY_COLOR } from "@/lib/activities/types";

export type PhotoFeatureProps = { id: string; thumbUrl: string; mediumUrl: string; caption: string | null; takenAt: string | null; tripSlug: string; tripTitle: string; activityId: string | null; gpsSource: string | null };
export type TrackFeatureProps = { trackId: string; activityId: string | null; activityTitle: string | null; activityType: string | null; source: string; name: string; tripSlug: string; tripTitle: string; color: string; startTime: string; distanceM: number | null };

export type MapPayload = {
  photos: GeoJSON.FeatureCollection<GeoJSON.Point, PhotoFeatureProps>;
  tracks: GeoJSON.FeatureCollection<GeoJSON.LineString, TrackFeatureProps>;
  bounds: [[number, number], [number, number]] | null;
  trips: { slug: string; title: string; themeKey: string; bounds: [[number, number], [number, number]] | null }[];
};

/** Photos and tracks for one trip, or for every trip the viewer may see. */
export async function buildMapPayload(viewer: Viewer, tripId?: string): Promise<MapPayload> {
  const tripWhere = tripId ? { id: tripId } : visibleTripsWhere(viewer);
  const trips = await db.trip.findMany({ where: tripWhere, select: { id: true, slug: true, title: true, themeKey: true }, orderBy: { startDate: "desc" } });
  const tripIds = trips.map((t) => t.id);
  const tripById = new Map(trips.map((t) => [t.id, t]));

  const [photos, tracks] = await Promise.all([
    db.photo.findMany({
      where: { tripId: { in: tripIds }, status: "READY", lat: { not: null }, lng: { not: null } },
      select: { id: true, lat: true, lng: true, caption: true, takenAt: true, updatedAt: true, tripId: true, activityId: true, gpsSource: true },
      orderBy: { takenAt: "asc" },
    }),
    db.track.findMany({
      where: { tripId: { in: tripIds } },
      select: { id: true, tripId: true, name: true, source: true, simplified: true, startTime: true, minLat: true, maxLat: true, minLng: true, maxLng: true, activity: { select: { id: true, title: true, type: true } }, stats: { select: { distanceM: true } } },
      orderBy: { startTime: "asc" },
    }),
  ]);

  const tripBounds = new Map<string, Bounds | null>();
  const add = (id: string, b: Bounds) => tripBounds.set(id, mergeBounds(tripBounds.get(id) ?? null, b));

  const photoFeatures = photos.map((p) => {
    const trip = tripById.get(p.tripId!)!;
    add(trip.id, { minLat: p.lat!, maxLat: p.lat!, minLng: p.lng!, maxLng: p.lng! });
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lng!, p.lat!] },
      properties: { id: p.id, thumbUrl: photoUrl(p, "thumb"), mediumUrl: photoUrl(p, "medium"), caption: p.caption, takenAt: p.takenAt?.toISOString() ?? null, tripSlug: trip.slug, tripTitle: trip.title, activityId: p.activityId, gpsSource: p.gpsSource },
    };
  });
  const trackFeatures = tracks.map((t) => {
    const trip = tripById.get(t.tripId)!;
    add(trip.id, { minLat: t.minLat, maxLat: t.maxLat, minLng: t.minLng, maxLng: t.maxLng });
    const line = (t.simplified as [number, number][]).map(([lat, lng]) => [lng, lat]);
    return {
      type: "Feature" as const,
      geometry: { type: "LineString" as const, coordinates: line },
      properties: {
        trackId: t.id,
        activityId: t.activity?.id ?? null,
        activityTitle: t.activity?.title ?? null,
        activityType: t.activity?.type ?? null,
        source: t.source,
        name: t.name,
        tripSlug: trip.slug,
        tripTitle: trip.title,
        color: t.activity ? ACTIVITY_COLOR[t.activity.type] : getTheme(trip.themeKey).map.trackColor,
        startTime: t.startTime.toISOString(),
        distanceM: t.stats?.distanceM ?? null,
      },
    };
  });

  const toPair = (b: Bounds | null | undefined): MapPayload["bounds"] => (b ? [[b.minLng, b.minLat], [b.maxLng, b.maxLat]] : null);
  let all: Bounds | null = null;
  for (const b of tripBounds.values()) all = mergeBounds(all, b);
  return {
    photos: { type: "FeatureCollection", features: photoFeatures },
    tracks: { type: "FeatureCollection", features: trackFeatures },
    bounds: toPair(all),
    trips: trips.map((t) => ({ slug: t.slug, title: t.title, themeKey: t.themeKey, bounds: toPair(tripBounds.get(t.id)) })),
  };
}
