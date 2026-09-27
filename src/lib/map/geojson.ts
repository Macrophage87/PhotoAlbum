import { db } from "@/lib/db";
import { canViewTrip, visibleMediaWhere, visibleTripsWhere } from "@/lib/auth/access";
import type { Viewer } from "@/lib/auth/viewer";
import { photoUrl } from "@/lib/photos/urls";
import { mergeBounds, type Bounds } from "@/lib/geo/bounds";
import { spreadOverlapping } from "./jitter";
import { getTheme } from "@/themes";
import { ACTIVITY_COLOR } from "@/lib/activities/types";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { Prisma } from "@/generated/prisma/client";
import { filterIsActive, NO_FILTER, type GalleryFilter } from "@/lib/photos/filters";
import { idsInLocalYear, idsMatching, intersectIds, type MatchScope } from "@/lib/photos/page";
import { idsWithPerson } from "@/lib/people/in-photos";
import { localDayInZone, photoDay } from "@/lib/time/local-day";
import { uploaderLabel } from "@/components/photos/toGrid";
import { overviewLines } from "./overview";

/**
 * What the map needs to colour a photograph by: its local day, its activity, and who uploaded it. Who uploaded it is
 * part of the members-only layer, so it is null for anybody who is not signed in.
 */
type ColourableProps = { day: string | null; activityTitle: string | null; uploaderId: string | null; uploaderName: string | null };
export type PhotoFeatureProps = { id: string; thumbUrl: string; mediumUrl: string; caption: string | null; takenAt: string | null; tripSlug: string; tripTitle: string; activityId: string | null; gpsSource: string | null } & ColourableProps;
export type TrackFeatureProps = { trackId: string; activityId: string | null; activityTitle: string | null; activityType: string | null; source: string; name: string; tripSlug: string; tripTitle: string; color: string; startTime: string; distanceM: number | null } & ColourableProps;

/** The day a photograph was taken where it was taken: its own clock's offset when it has one, else the trip's zone. */
function dayOf(takenAt: Date | null, tzOffsetMin: number | null, timezone: string): string | null {
  if (!takenAt) return null;
  return photoDay(takenAt, tzOffsetMin, timezone);
}

type Uploader = { id: string; name: string | null; email: string } | null;
const who = (member: boolean, u: Uploader) => (member && u ? { uploaderId: u.id, uploaderName: uploaderLabel(u.name, u.email) } : { uploaderId: null, uploaderName: null });

export type MapPayload = {
  photos: GeoJSON.FeatureCollection<GeoJSON.Point, PhotoFeatureProps>;
  tracks: GeoJSON.FeatureCollection<GeoJSON.LineString, TrackFeatureProps>;
  bounds: [[number, number], [number, number]] | null;
  trips: { slug: string; title: string; themeKey: string; bounds: [[number, number], [number, number]] | null }[];
};


/**
 * The question narrowed down to a clause the photo query can take.
 *
 * Words and years are answered as id lists, exactly as the galleries and the timelines answer them, so the same
 * search means the same thing on every surface: asking the map for "lighthouse" shows where the lighthouse
 * photographs were taken, which is a thing a map can answer and a list cannot.
 */
export async function narrowing(filter: GalleryFilter, scope: MatchScope): Promise<{ where: Prisma.PhotoWhereInput; nothing: boolean }> {
  const lists: string[][] = [];
  if (filter.q) lists.push(await idsMatching(filter.q, { member: filter.member, scope }));
  if (filter.year) lists.push(await idsInLocalYear(scope.tripId ?? null, filter.year));
  // One list per name, so two names means the photographs they are both on rather than either.
  for (const id of filter.personIds) lists.push(await idsWithPerson(id));
  const restrict = lists.length ? intersectIds(lists) : null;
  if (restrict && restrict.length === 0) return { where: {}, nothing: true };
  return {
    where: {
      ...(filter.uploaderId ? { uploaderId: filter.uploaderId } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.activityId ? { activityId: filter.activityId } : {}),
      ...(restrict ? { id: { in: restrict } } : {}),
    },
    nothing: false,
  };
}

/**
 * Photos and tracks for one trip, or everything the viewer may see.
 *
 * Across all trips the photos are not looked up through the trips: an item can be on no trip at all, or live only in
 * a collection, and those used to be missing from this map while showing up perfectly well on a collection's own map.
 * The filter every other surface uses decides what is here, and a trip is only needed to name and colour what it holds.
 */
export async function buildMapPayload(viewer: Viewer, tripId?: string, given: GalleryFilter = NO_FILTER): Promise<MapPayload> {
  const member = viewer.kind === "user";
  const filter = { ...given, member: given.member && member };
  const active = filterIsActive(filter);
  // Across every trip, the words are asked of what this viewer may see, so the limit on matches is spent there.
  const narrowed = await narrowing(filter, tripId ? { tripId, placed: true } : { publicOnly: !member, placed: true });
  const tripWhere = tripId ? { id: tripId, deletingAt: null } : visibleTripsWhere(viewer);
  const trips = await db.trip.findMany({ where: tripWhere, select: { id: true, slug: true, title: true, themeKey: true, timezone: true }, orderBy: { startDate: "desc" } });
  const tripIds = trips.map((t) => t.id);
  const tripById = new Map(trips.map((t) => [t.id, t]));

  const [found, allTracks] = await Promise.all([
    // Nothing can match: say so without asking the database a question whose answer is already known.
    narrowed.nothing
      ? []
      : db.photo.findMany({
          where: {
            ...(tripId ? { tripId } : visibleMediaWhere(viewer)),
            ...NOT_TRASHED,
            status: "READY",
            lat: { not: null },
            lng: { not: null },
            ...narrowed.where,
          },
          select: { id: true, lat: true, lng: true, caption: true, takenAt: true, tzOffsetMin: true, updatedAt: true, tripId: true, activityId: true, gpsSource: true, activity: { select: { title: true } }, uploader: { select: { id: true, name: true, email: true } } },
          orderBy: { takenAt: "asc" },
        }),
    db.track.findMany({
      where: { tripId: { in: tripIds } },
      select: { id: true, tripId: true, name: true, source: true, simplified: Boolean(tripId), overview: !tripId, startTime: true, minLat: true, maxLat: true, minLng: true, maxLng: true, activity: { select: { id: true, title: true, type: true } }, stats: { select: { distanceM: true } }, uploader: { select: { id: true, name: true, email: true } } },
      orderBy: { startTime: "asc" },
    }),
  ]);
  // Narrowed, a track stays only while a photograph inside its activity does, which is the rule the timeline keeps.
  const withPhotos = new Set(found.map((p) => p.activityId).filter(Boolean) as string[]);
  const tracks = active ? allTracks.filter((t) => t.activity && withPhotos.has(t.activity.id)) : allTracks;
  // Across every trip each line is a thinned copy; one trip's map draws its lines whole.
  const overview = tripId ? null : await overviewLines(tracks);

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
      properties: {
        id: p.id,
        thumbUrl: photoUrl(p, "thumb"),
        mediumUrl: photoUrl(p, "medium"),
        caption: p.caption,
        takenAt: p.takenAt?.toISOString() ?? null,
        tripSlug: trip?.slug ?? "",
        tripTitle: trip?.title ?? "",
        // An activity belongs to its trip: named only where the trip itself is, which it is not for a photograph
        // reached through a public collection from a trip this viewer may not open.
        activityId: trip ? p.activityId : null,
        gpsSource: p.gpsSource,
        day: dayOf(p.takenAt, p.tzOffsetMin, trip?.timezone ?? "UTC"),
        activityTitle: trip ? (p.activity?.title ?? null) : null,
        ...who(member, p.uploader),
      },
    };
  });
  const trackFeatures = tracks.map((t) => {
    const trip = tripById.get(t.tripId)!;
    add(trip.id, { minLat: t.minLat, maxLat: t.maxLat, minLng: t.minLng, maxLng: t.maxLng });
    const stored = (overview ? overview.get(t.id) : t.simplified) as [number, number][] | undefined;
    const line = (stored ?? []).map(([lat, lng]) => [lng, lat]);
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
        day: localDayInZone(t.startTime, trip.timezone),
        ...who(member, t.uploader),
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
export async function buildCollectionMapPayload(viewer: Viewer, collectionId: string, filter: GalleryFilter = NO_FILTER): Promise<MapPayload> {
  const narrowed = await narrowing({ ...filter, member: filter.member && viewer.kind === "user" }, { collectionId, placed: true });
  const found = narrowed.nothing ? [] : await db.photo.findMany({
    where: { ...NOT_TRASHED, status: "READY", lat: { not: null }, lng: { not: null }, collections: { some: { collectionId } }, ...narrowed.where },
    select: { id: true, lat: true, lng: true, caption: true, takenAt: true, tzOffsetMin: true, updatedAt: true, activityId: true, gpsSource: true, activity: { select: { title: true } }, uploader: { select: { id: true, name: true, email: true } }, trip: { select: { id: true, slug: true, title: true, visibility: true, shareToken: true, timezone: true } } },
    orderBy: { takenAt: "asc" },
  });
  let all: Bounds | null = null;
  const photos = spreadOverlapping(found.map((p) => ({ ...p, lat: p.lat!, lng: p.lng! })));
  const features = photos.map((p) => {
    all = mergeBounds(all, { minLat: p.lat, maxLat: p.lat, minLng: p.lng, maxLng: p.lng });
    const tripOpen = Boolean(p.trip && canViewTrip(viewer, p.trip));
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        thumbUrl: photoUrl(p, "thumb"),
        mediumUrl: photoUrl(p, "medium"),
        caption: p.caption,
        takenAt: p.takenAt?.toISOString() ?? null,
        tripSlug: tripOpen ? p.trip!.slug : "",
        tripTitle: tripOpen ? p.trip!.title : "",
        activityId: tripOpen ? p.activityId : null,
        gpsSource: p.gpsSource,
        day: dayOf(p.takenAt, p.tzOffsetMin, p.trip?.timezone ?? "UTC"),
        // An activity belongs to its trip: named only where the trip itself may be opened, like the trip's own name.
        activityTitle: tripOpen ? (p.activity?.title ?? null) : null,
        ...who(viewer.kind === "user", p.uploader),
      },
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

/**
 * One activity's track and its own photographs, and nothing else of the trip. The caller has already checked the
 * viewer may open the activity; `tripOpen` says whether they may open its trip too, which is the only case the trip
 * is named in (an activity's link can sit on a private trip, and says nothing about it).
 */
export async function buildActivityMapPayload(viewer: Viewer, activityId: string, tripOpen: boolean): Promise<MapPayload> {
  const member = viewer.kind === "user";
  const activity = await db.activity.findUniqueOrThrow({
    where: { id: activityId },
    select: {
      id: true,
      tripId: true,
      title: true,
      type: true,
      trip: { select: { slug: true, title: true, themeKey: true, timezone: true } },
      track: { select: { id: true, name: true, source: true, simplified: true, startTime: true, minLat: true, maxLat: true, minLng: true, maxLng: true, stats: { select: { distanceM: true } }, uploader: { select: { id: true, name: true, email: true } } } },
    },
  });
  const trip = activity.trip;
  const named = { tripSlug: tripOpen ? trip.slug : "", tripTitle: tripOpen ? trip.title : "" };
  const found = await db.photo.findMany({
    where: { activityId: activity.id, tripId: activity.tripId, ...NOT_TRASHED, status: "READY", lat: { not: null }, lng: { not: null } },
    select: { id: true, lat: true, lng: true, caption: true, takenAt: true, tzOffsetMin: true, updatedAt: true, activityId: true, gpsSource: true, uploader: { select: { id: true, name: true, email: true } } },
    orderBy: { takenAt: "asc" },
  });
  let photoBounds: Bounds | null = null;
  const photoFeatures = spreadOverlapping(found.map((p) => ({ ...p, lat: p.lat!, lng: p.lng! }))).map((p) => {
    photoBounds = mergeBounds(photoBounds, { minLat: p.lat, maxLat: p.lat, minLng: p.lng, maxLng: p.lng });
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        thumbUrl: photoUrl(p, "thumb"),
        mediumUrl: photoUrl(p, "medium"),
        caption: p.caption,
        takenAt: p.takenAt?.toISOString() ?? null,
        ...named,
        activityId: p.activityId,
        gpsSource: p.gpsSource,
        day: dayOf(p.takenAt, p.tzOffsetMin, trip.timezone),
        activityTitle: activity.title,
        ...who(member, p.uploader),
      },
    };
  });
  const t = activity.track;
  const trackFeatures = t
    ? [
        {
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: (t.simplified as [number, number][]).map(([lat, lng]) => [lng, lat]) },
          properties: {
            trackId: t.id,
            activityId: activity.id,
            activityTitle: activity.title,
            activityType: activity.type,
            source: t.source,
            // A track is named after the file it came from ("Jo's Acadia walk.gpx"), which can name the trip; a link
            // holder who may not open the trip gets the activity's own title instead.
            name: tripOpen ? t.name : activity.title,
            ...named,
            color: ACTIVITY_COLOR[activity.type],
            startTime: t.startTime.toISOString(),
            distanceM: t.stats?.distanceM ?? null,
            day: localDayInZone(t.startTime, trip.timezone),
            ...who(member, t.uploader),
          },
        },
      ]
    : [];
  // The map opens on the route, as the activity page always has; with no route, on the photographs.
  const b: Bounds | null = t ? { minLat: t.minLat, maxLat: t.maxLat, minLng: t.minLng, maxLng: t.maxLng } : photoBounds;
  return {
    photos: { type: "FeatureCollection", features: photoFeatures },
    tracks: { type: "FeatureCollection", features: trackFeatures },
    bounds: b ? [[b.minLng, b.minLat], [b.maxLng, b.maxLat]] : null,
    trips: [],
  };
}
