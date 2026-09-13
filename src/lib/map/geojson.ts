import { db } from "@/lib/db";
import { canViewTrip, visibleMediaWhere, visibleTripsWhere } from "@/lib/auth/access";
import type { Viewer } from "@/lib/auth/viewer";
import { photoUrl } from "@/lib/photos/urls";
import { mergeBounds, type Bounds } from "@/lib/geo/bounds";
import { spreadOverlapping } from "./jitter";
import { getTheme } from "@/themes";
import { ACTIVITY_COLOR } from "@/lib/activities/types";
import { NOT_TRASHED } from "@/lib/photos/trash";

export type PhotoFeatureProps = { id: string; thumbUrl: string; mediumUrl: string; caption: string | null; takenAt: string | null; tripSlug: string; tripTitle: string; activityId: string | null; gpsSource: string | null };
export type TrackFeatureProps = { trackId: string; activityId: string | null; activityTitle: string | null; activityType: string | null; source: string; name: string; tripSlug: string; tripTitle: string; color: string; startTime: string; distanceM: number | null };

export type MapPayload = {
  photos: GeoJSON.FeatureCollection<GeoJSON.Point, PhotoFeatureProps>;
  tracks: GeoJSON.FeatureCollection<GeoJSON.LineString, TrackFeatureProps>;
  bounds: [[number, number], [number, number]] | null;
  trips: { slug: string; title: string; themeKey: string; bounds: [[number, number], [number, number]] | null }[];
};

/**
 * Photos and tracks for one trip, or everything the viewer may see.
 *
 * Across all trips the photos are not looked up through the trips: an item can be on no trip at all, or live only in
 * a collection, and those used to be missing from this map while showing up perfectly well on a collection's own map.
 * The filter every other surface uses decides what is here, and a trip is only needed to name and colour what it holds.
 */
export async function buildMapPayload(viewer: Viewer, tripId?: string): Promise<MapPayload> {
  const tripWhere = tripId ? { id: tripId } : visibleTripsWhere(viewer);
  const trips = await db.trip.findMany({ where: tripWhere, select: { id: true, slug: true, title: true, themeKey: true }, orderBy: { startDate: "desc" } });
  const tripIds = trips.map((t) => t.id);
  const tripById = new Map(trips.map((t) => [t.id, t]));

  const [found, tracks] = await Promise.all([
    db.photo.findMany({
      where: {
        ...(tripId ? { tripId } : visibleMediaWhere(viewer)),
        ...NOT_TRASHED,
        status: "READY",
        lat: { not: null },
        lng: { not: null },
      },
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
  let loose: Bounds | null = null; // photos on no trip the viewer can see: part of the map, part of no trip's bounds

  const photos = spreadOverlapping(found.map((p) => ({ ...p, lat: p.lat!, lng: p.lng! })));
  const photoFeatures = photos.map((p) => {
    const trip = p.tripId ? tripById.get(p.tripId) : undefined;
    const box = { minLat: p.lat, maxLat: p.lat, minLng: p.lng, maxLng: p.lng };
    if (trip) add(trip.id, box);
    else loose = mergeBounds(loose, box);
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      properties: { id: p.id, thumbUrl: photoUrl(p, "thumb"), mediumUrl: photoUrl(p, "medium"), caption: p.caption, takenAt: p.takenAt?.toISOString() ?? null, tripSlug: trip?.slug ?? "", tripTitle: trip?.title ?? "", activityId: p.activityId, gpsSource: p.gpsSource },
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
  let all: Bounds | null = loose;
  for (const b of tripBounds.values()) all = mergeBounds(all, b);
  return {
    photos: { type: "FeatureCollection", features: photoFeatures },
    tracks: { type: "FeatureCollection", features: trackFeatures },
    bounds: toPair(all),
    trips: trips.map((t) => ({ slug: t.slug, title: t.title, themeKey: t.themeKey, bounds: toPair(tripBounds.get(t.id)) })),
  };
}

/** Photos in a collection (no tracks). The caller has already checked the viewer may open the collection; a photo's trip is named only when the viewer may open that trip too. */
export async function buildCollectionMapPayload(viewer: Viewer, collectionId: string): Promise<MapPayload> {
  const found = await db.photo.findMany({
    where: { ...NOT_TRASHED, status: "READY", lat: { not: null }, lng: { not: null }, collections: { some: { collectionId } } },
    select: { id: true, lat: true, lng: true, caption: true, takenAt: true, updatedAt: true, activityId: true, gpsSource: true, trip: { select: { id: true, slug: true, title: true, visibility: true, shareToken: true } } },
    orderBy: { takenAt: "asc" },
  });
  let all: Bounds | null = null;
  const photos = spreadOverlapping(found.map((p) => ({ ...p, lat: p.lat!, lng: p.lng! })));
  const features = photos.map((p) => {
    all = mergeBounds(all, { minLat: p.lat, maxLat: p.lat, minLng: p.lng, maxLng: p.lng });
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      properties: { id: p.id, thumbUrl: photoUrl(p, "thumb"), mediumUrl: photoUrl(p, "medium"), caption: p.caption, takenAt: p.takenAt?.toISOString() ?? null, tripSlug: p.trip && canViewTrip(viewer, p.trip) ? p.trip.slug : "", tripTitle: p.trip && canViewTrip(viewer, p.trip) ? p.trip.title : "", activityId: p.activityId, gpsSource: p.gpsSource },
    };
  });
  const b = all as Bounds | null;
  return {
    photos: { type: "FeatureCollection", features },
    tracks: { type: "FeatureCollection", features: [] },
    bounds: b ? [[b.minLng, b.minLat], [b.maxLng, b.maxLat]] : null,
    trips: [],
  };
}
