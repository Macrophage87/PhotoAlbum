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
import { localDayFromOffset, localDayInZone } from "@/lib/time/local-day";
import { uploaderLabel } from "@/components/photos/toGrid";
import { overviewLines } from "./overview";
import { cachedMapState, digest } from "./cache";
import { ringsFor, SLOT_COUNT, type Colourable, type RingKey, type Rings } from "./colour-by";
import { gridCells, inViewport, mercator, POINT_LIMIT, type MapViewport } from "./view";

/**
 * A photograph as a map of trips or collections is sent it: its id, where its pin goes, the day it was taken where it
 * was taken, and the slot of its ring for each way of colouring — by day, by activity, by who uploaded. The last is
 * null for anybody not signed in: who uploaded what is the family's, and a slot is all a member is sent of it here,
 * never a name. Everything else about a photograph (its caption, its pictures, its activity, who uploaded it) is
 * asked for when it is clicked, from `/api/map/photos`, so a map of twelve thousand photographs does not carry twelve
 * thousand captions to show one.
 */
export type PhotoPoint = [id: string, lng: number, lat: number, day: string | null, daySlot: number, activitySlot: number, uploaderSlot: number | null];

/**
 * Photographs sent as one, when there are too many in view to send apiece: where to draw the group, how many are in
 * it, the box they fill (west, south, east, north), and how many are in each ring slot for each way of colouring, as
 * `[slot, count, slot, count…]`.
 */
export type PhotoCell = { at: [number, number]; n: number; box: [number, number, number, number]; rings: { day: number[]; activity: number[]; uploader: number[] | null } };

export type MapPhotos = {
  points: PhotoPoint[];
  cells: PhotoCell[];
  /** Every photograph on the map is in `points`, so there is nothing more to ask for as the map moves. */
  complete: boolean;
  /**
   * Which legends the ring slots here are numbered by. A view answered after the album changed may be numbered by
   * new ones, and then the map asks for its legends again rather than colour by the wrong ones.
   */
  version: string;
};

/** The legend and colours for each way of colouring the rings, worked out over the whole map, not just the view. */
export type MapRings = { day: RingKey; activity: RingKey; /** Members only. */ uploader: RingKey | null };

/** Who uploaded a photograph or track, for members; null for anybody who is not signed in. */
type UploaderProps = { uploaderId: string | null; uploaderName: string | null };
/** A photograph on one activity's map, which is small enough to send whole: at most one outing's photographs. */
export type PhotoFeatureProps = { id: string; thumbUrl: string; mediumUrl: string; caption: string | null; takenAt: string | null; tripSlug: string; tripTitle: string; activityId: string | null; gpsSource: string | null; day: string | null; activityTitle: string | null } & UploaderProps;
export type TrackFeatureProps = { trackId: string; activityId: string | null; activityTitle: string | null; activityType: string | null; source: string; name: string; tripSlug: string; tripTitle: string; color: string; startTime: string; distanceM: number | null };
/** A track on a map whose rings can be coloured, with its ring slot for each way of colouring, as a photograph has. */
export type MapTrackProps = TrackFeatureProps & { daySlot: number; activitySlot: number; uploaderSlot: number | null };

/** The day a photograph was taken where it was taken: its own clock's offset when it has one, else the trip's zone. */
function dayOf(takenAt: Date | null, tzOffsetMin: number | null, timezone: string): string | null {
  if (!takenAt) return null;
  return tzOffsetMin !== null ? localDayFromOffset(takenAt, tzOffsetMin) : localDayInZone(takenAt, timezone);
}

type Uploader = { id: string; name: string | null; email: string } | null;
const who = (member: boolean, u: Uploader): UploaderProps => (member && u ? { uploaderId: u.id, uploaderName: uploaderLabel(u.name, u.email) } : { uploaderId: null, uploaderName: null });

type Pair = [[number, number], [number, number]];

export type MapPayload = {
  photos: MapPhotos;
  /** Which legends `rings` are, as each view's answer says of its own slots. */
  version: string;
  /** How many photographs are on the whole map, in view or not. */
  total: number;
  rings: MapRings;
  tracks: GeoJSON.FeatureCollection<GeoJSON.LineString, MapTrackProps>;
  bounds: Pair | null;
  trips: { slug: string; title: string; themeKey: string; bounds: Pair | null }[];
};

/** One activity's map: its route and its own photographs, sent whole. */
export type ActivityMapPayload = {
  photos: GeoJSON.FeatureCollection<GeoJSON.Point, PhotoFeatureProps>;
  tracks: GeoJSON.FeatureCollection<GeoJSON.LineString, TrackFeatureProps & UploaderProps & { day: string }>;
  bounds: Pair | null;
  trips: [];
};

/** A placed photograph as the map works with it before sending: its activity only where its trip may be named here, its uploader only for a member. */
type Placed = { id: string; lat: number; lng: number; takenAt: Date | null; day: string | null; activityId: string | null; uploaderId: string | null; tripId: string | null };
/** A photograph's or a track's ring slot by day, by activity and by who uploaded (members only). */
type Slots = [number, number, number | null];

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const toPair = (b: Bounds | null | undefined): Pair | null => (b ? [[b.minLng, b.minLat], [b.maxLng, b.maxLat]] : null);

/**
 * Which ring each photograph and track gets, for every way of colouring, with the legends. Worked out over the whole
 * map rather than what is in view, so a day keeps its colour as the map is moved and the legend counts everything.
 */
async function colourMap(member: boolean, rows: Placed[], tracks: Colourable[]): Promise<{ rings: MapRings; photoSlots: Slots[]; trackSlots: Slots[] }> {
  const activityIds = [...new Set(rows.map((r) => r.activityId).filter((id): id is string => id !== null))];
  const uploaderIds = member ? [...new Set(rows.map((r) => r.uploaderId).filter((id): id is string => id !== null))] : [];
  const [activities, uploaders] = await Promise.all([
    activityIds.length ? db.activity.findMany({ where: { id: { in: activityIds } }, select: { id: true, title: true } }) : [],
    uploaderIds.length ? db.user.findMany({ where: { id: { in: uploaderIds } }, select: { id: true, name: true, email: true } }) : [],
  ]);
  const titles = new Map(activities.map((a) => [a.id, a.title]));
  const names = new Map(uploaders.map((u) => [u.id, uploaderLabel(u.name, u.email)]));
  const keys: Colourable[] = rows.map((r) => ({
    day: r.day,
    activityId: r.activityId,
    activityTitle: r.activityId ? (titles.get(r.activityId) ?? null) : null,
    uploaderId: r.uploaderId,
    uploaderName: r.uploaderId ? (names.get(r.uploaderId) ?? null) : null,
    at: r.takenAt?.getTime() ?? null,
  }));
  const day = ringsFor("day", keys, tracks);
  const activity = ringsFor("activity", keys, tracks);
  const uploader = member ? ringsFor("uploader", keys, tracks) : null;
  const slotsOf = (k: Colourable): Slots => [day.photoSlot(k), activity.photoSlot(k), uploader ? uploader.photoSlot(k) : null];
  const legend = (r: Rings): RingKey => ({ groups: r.groups, colours: r.colours });
  return { rings: { day: legend(day), activity: legend(activity), uploader: uploader && legend(uploader) }, photoSlots: keys.map(slotsOf), trackSlots: tracks.map(slotsOf) };
}

/**
 * The photographs to send: every one when there are few enough, else nothing until a view is asked for; for a view,
 * each one in it, or past `POINT_LIMIT` the view grouped into cells, a cell of one sent as the photograph itself.
 */
function photosFor({ rows, slots, grid, version }: MapState, view: MapViewport | null): MapPhotos {
  const point = (i: number): PhotoPoint => [rows[i].id, round(rows[i].lng), round(rows[i].lat), rows[i].day, ...slots[i]];
  if (!view) return rows.length <= POINT_LIMIT ? { points: rows.map((_, i) => point(i)), cells: [], complete: true, version } : { points: [], cells: [], complete: false, version };
  const shown: { i: number; lat: number; lng: number; x: number; y: number }[] = [];
  rows.forEach((r, i) => {
    if (inViewport(view, r.lat, r.lng)) shown.push({ i, lat: r.lat, lng: r.lng, x: grid[i * 2], y: grid[i * 2 + 1] });
  });
  if (shown.length <= POINT_LIMIT) return { points: shown.map((s) => point(s.i)), cells: [], complete: false, version };
  const single: number[] = [];
  const cells: PhotoCell[] = [];
  const tally = (members: { i: number }[], k: 0 | 1 | 2) => {
    const counts = new Array<number>(SLOT_COUNT).fill(0);
    for (const m of members) counts[slots[m.i][k]!]++;
    return counts.flatMap((n, slot) => (n ? [slot, n] : []));
  };
  for (const c of gridCells(shown, view.zoom)) {
    if (c.n === 1) single.push(c.members[0].i);
    else {
      const members = c.members;
      cells.push({ at: [round(c.lng), round(c.lat)], n: c.n, box: [round(c.box[0]), round(c.box[1]), round(c.box[2]), round(c.box[3])], rings: { day: tally(members, 0), activity: tally(members, 1), uploader: slots[members[0].i][2] === null ? null : tally(members, 2) } });
    }
  }
  // In the order they were taken, like every other answer, so the lightbox steps through them in time.
  return { points: single.sort((a, b) => a - b).map(point), cells, complete: false, version };
}

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

type TripRow = { id: string; slug: string; title: string; themeKey: string; timezone: string };
type TrackRow = { id: string; tripId: string; name: string; source: string; startTime: Date; minLat: number; maxLat: number; minLng: number; maxLng: number; activity: { id: string; title: string; type: keyof typeof ACTIVITY_COLOR } | null; stats: { distanceM: number | null } | null; uploader: Uploader };

/**
 * Everything a map of trips or of a collection holds, worked out once for everybody who sees it the same way and then
 * answered from (see `cache.ts`): its placed photographs with their pins spread and their ring slots, its legends,
 * and for a map of trips its tracks and trips. Nothing here depends on what part of the map is in view.
 */
type MapState = { rows: Placed[]; slots: Slots[]; /** Each photograph's place on the Mercator square, for grouping. */ grid: Float64Array; rings: MapRings; version: string; tracks: TrackRow[]; trackSlots: Slots[]; trips: TripRow[] };

/** Every photograph's place on the Mercator square, x and y in turn. */
function gridOf(rows: Placed[]): Float64Array {
  const grid = new Float64Array(rows.length * 2);
  rows.forEach((r, i) => grid.set(mercator(r.lat, r.lng), i * 2));
  return grid;
}

/** The legends' fingerprint, which says whether two answers number their ring slots the same way. */
const versionOf = (rings: MapRings, total: number) => digest([rings, total]).slice(0, 16);

/**
 * The map of one trip, or of everything the viewer may see, worked out afresh.
 *
 * Across all trips the photos are not looked up through the trips: an item can be on no trip at all, or live only in
 * a collection, and those used to be missing from this map while showing up perfectly well on a collection's own map.
 * The filter every other surface uses decides what is here, and a trip is only needed to name and colour what it holds.
 */
async function buildTripsState(viewer: Viewer, tripId: string | undefined, narrowed: { where: Prisma.PhotoWhereInput; nothing: boolean }, active: boolean): Promise<MapState> {
  const member = viewer.kind === "user";
  const tripWhere = tripId ? { id: tripId } : visibleTripsWhere(viewer);
  const trips: TripRow[] = await db.trip.findMany({ where: tripWhere, select: { id: true, slug: true, title: true, themeKey: true, timezone: true }, orderBy: { startDate: "desc" } });
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
          select: { id: true, lat: true, lng: true, takenAt: true, tzOffsetMin: true, tripId: true, activityId: true, uploaderId: true },
          orderBy: [{ takenAt: "asc" }, { id: "asc" }],
        }),
    db.track.findMany({
      where: { tripId: { in: tripIds } },
      select: { id: true, tripId: true, name: true, source: true, startTime: true, minLat: true, maxLat: true, minLng: true, maxLng: true, activity: { select: { id: true, title: true, type: true } }, stats: { select: { distanceM: true } }, uploader: { select: { id: true, name: true, email: true } } },
      orderBy: { startTime: "asc" },
    }),
  ]);
  // Narrowed, a track stays only while a photograph inside its activity does, which is the rule the timeline keeps.
  const withPhotos = new Set(found.map((p) => p.activityId).filter(Boolean) as string[]);
  const tracks = active ? allTracks.filter((t) => t.activity && withPhotos.has(t.activity.id)) : allTracks;
  const rows: Placed[] = spreadOverlapping(
    found.map((p) => {
      const trip = p.tripId ? tripById.get(p.tripId) : undefined;
      return {
        id: p.id,
        lat: p.lat!,
        lng: p.lng!,
        takenAt: p.takenAt,
        day: dayOf(p.takenAt, p.tzOffsetMin, trip?.timezone ?? "UTC"),
        // An activity belongs to its trip: coloured by only where the trip itself is named, which it is not for a
        // photograph reached through a public collection from a trip this viewer may not open.
        activityId: trip ? p.activityId : null,
        uploaderId: member ? p.uploaderId : null,
        tripId: trip?.id ?? null,
      };
    }),
  );
  const trackKeys = tracks.map((t): Colourable => {
    const u = member ? (t.uploader as Uploader) : null;
    return { day: localDayInZone(t.startTime, tripById.get(t.tripId)!.timezone), activityId: t.activity?.id ?? null, activityTitle: t.activity?.title ?? null, uploaderId: u?.id ?? null, uploaderName: u ? uploaderLabel(u.name, u.email) : null, at: t.startTime.getTime() };
  });
  const { rings, photoSlots, trackSlots } = await colourMap(member, rows, trackKeys);
  return { rows, slots: photoSlots, grid: gridOf(rows), rings, version: versionOf(rings, rows.length), tracks, trackSlots, trips };
}

/**
 * The map of one trip or of everything, from what was already worked out when it can be. Everything that changes
 * what it holds or names is in the key: the map, whether the viewer is a member, and what the filter narrowed it to.
 * Share cookies are not: they never widen the map of everything, and a trip's map is the trip's for whoever may open it.
 */
async function tripsState(viewer: Viewer, tripId: string | undefined, given: GalleryFilter): Promise<MapState> {
  const member = viewer.kind === "user";
  const filter = { ...given, member: given.member && member };
  // Across every trip, the words are asked of what this viewer may see, so the limit on matches is spent there.
  const narrowed = await narrowing(filter, tripId ? { tripId, placed: true } : { publicOnly: !member, placed: true });
  const active = filterIsActive(filter);
  return cachedMapState(`trips:${tripId ?? "*"}:${member ? "member" : "visitor"}:${digest([narrowed, active])}`, () => buildTripsState(viewer, tripId, narrowed, active));
}

/**
 * The map of one trip, or of everything the viewer may see: its tracks, its trips, its legends, and its photographs
 * when there are few enough to send at once (else they are asked for a view at a time, `buildMapView`).
 */
export async function buildMapPayload(viewer: Viewer, tripId?: string, given: GalleryFilter = NO_FILTER): Promise<MapPayload> {
  const state = await tripsState(viewer, tripId, given);
  const { rows, tracks, trackSlots, trips, rings, version } = state;
  // The lines are only for this first answer, so they are read here rather than kept. Across every trip each line is
  // a thinned copy; one trip's map draws its lines whole.
  const lines = tracks.length ? await db.track.findMany({ where: { id: { in: tracks.map((t) => t.id) } }, select: { id: true, simplified: Boolean(tripId), overview: !tripId } }) : [];
  const overview = tripId ? null : await overviewLines(lines.map((l) => ({ id: l.id, overview: l.overview })));
  const whole = new Map(lines.map((l) => [l.id, l.simplified]));
  const tripById = new Map(trips.map((t) => [t.id, t]));

  const tripBounds = new Map<string, Bounds | null>();
  const add = (id: string, b: Bounds) => tripBounds.set(id, mergeBounds(tripBounds.get(id) ?? null, b));
  let loose: Bounds | null = null; // photos on no trip the viewer can see: part of the map, part of no trip's bounds
  for (const p of rows) {
    const box = { minLat: p.lat, maxLat: p.lat, minLng: p.lng, maxLng: p.lng };
    if (p.tripId) add(p.tripId, box);
    else loose = mergeBounds(loose, box);
  }
  const trackFeatures = tracks.map((t, i) => {
    const trip = tripById.get(t.tripId)!;
    add(trip.id, { minLat: t.minLat, maxLat: t.maxLat, minLng: t.minLng, maxLng: t.maxLng });
    const stored = (overview ? overview.get(t.id) : whole.get(t.id)) as [number, number][] | undefined;
    const line = (stored ?? []).map(([lat, lng]) => [lng, lat]);
    const [daySlot, activitySlot, uploaderSlot] = trackSlots[i];
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
        daySlot,
        activitySlot,
        uploaderSlot,
      },
    };
  });

  let all: Bounds | null = loose;
  for (const b of tripBounds.values()) all = mergeBounds(all, b);
  return {
    photos: photosFor(state, null),
    version,
    total: rows.length,
    rings,
    tracks: { type: "FeatureCollection", features: trackFeatures },
    bounds: toPair(all),
    trips: trips.map((t) => ({ slug: t.slug, title: t.title, themeKey: t.themeKey, bounds: toPair(tripBounds.get(t.id)) })),
  };
}

/** The photographs of `buildMapPayload`'s map that are in one view, one by one or grouped into cells. */
export async function buildMapView(viewer: Viewer, tripId: string | undefined, given: GalleryFilter, view: MapViewport): Promise<MapPhotos> {
  return photosFor(await tripsState(viewer, tripId, given), view);
}

/** A collection's map worked out afresh (no tracks): a photo's activity is coloured by only when the viewer may open its trip too. */
async function buildCollectionState(viewer: Viewer, collectionId: string, narrowed: { where: Prisma.PhotoWhereInput; nothing: boolean }): Promise<MapState> {
  const member = viewer.kind === "user";
  const found = narrowed.nothing ? [] : await db.photo.findMany({
    where: { ...NOT_TRASHED, status: "READY", lat: { not: null }, lng: { not: null }, collections: { some: { collectionId } }, ...narrowed.where },
    select: { id: true, lat: true, lng: true, takenAt: true, tzOffsetMin: true, activityId: true, uploaderId: true, trip: { select: { id: true, visibility: true, shareToken: true, timezone: true } } },
    orderBy: [{ takenAt: "asc" }, { id: "asc" }],
  });
  const rows = spreadOverlapping(
    found.map((p) => ({
      id: p.id,
      lat: p.lat!,
      lng: p.lng!,
      takenAt: p.takenAt,
      day: dayOf(p.takenAt, p.tzOffsetMin, p.trip?.timezone ?? "UTC"),
      // An activity belongs to its trip: coloured by only where the trip itself may be opened, like the trip's own name.
      activityId: p.trip && canViewTrip(viewer, p.trip) ? p.activityId : null,
      uploaderId: member ? p.uploaderId : null,
      tripId: null,
    })),
  );
  const { rings, photoSlots } = await colourMap(member, rows, []);
  return { rows, slots: photoSlots, grid: gridOf(rows), rings, version: versionOf(rings, rows.length), tracks: [], trackSlots: [], trips: [] };
}

/**
 * A collection's map, from what was already worked out when it can be. The caller has already checked the viewer may
 * open the collection. A visitor's link cookies are part of the key (as a digest), since a trip's link decides whether
 * that trip's activities colour its photographs here.
 */
async function collectionState(viewer: Viewer, collectionId: string, given: GalleryFilter): Promise<MapState> {
  const member = viewer.kind === "user";
  const narrowed = await narrowing({ ...given, member: given.member && member }, { collectionId, placed: true });
  const who = member ? "member" : `visitor-${digest([...viewer.shareTokens].sort())}`;
  return cachedMapState(`collection:${collectionId}:${who}:${digest(narrowed)}`, () => buildCollectionState(viewer, collectionId, narrowed));
}

export async function buildCollectionMapPayload(viewer: Viewer, collectionId: string, filter: GalleryFilter = NO_FILTER): Promise<MapPayload> {
  const state = await collectionState(viewer, collectionId, filter);
  let all: Bounds | null = null;
  for (const p of state.rows) all = mergeBounds(all, { minLat: p.lat, maxLat: p.lat, minLng: p.lng, maxLng: p.lng });
  return { photos: photosFor(state, null), version: state.version, total: state.rows.length, rings: state.rings, tracks: { type: "FeatureCollection", features: [] }, bounds: toPair(all), trips: [] };
}

/** The photographs of a collection's map that are in one view. */
export async function buildCollectionMapView(viewer: Viewer, collectionId: string, filter: GalleryFilter, view: MapViewport): Promise<MapPhotos> {
  return photosFor(await collectionState(viewer, collectionId, filter), view);
}

/**
 * One activity's track and its own photographs, and nothing else of the trip. The caller has already checked the
 * viewer may open the activity; `tripOpen` says whether they may open its trip too, which is the only case the trip
 * is named in (an activity's link can sit on a private trip, and says nothing about it). One outing's photographs
 * are few enough to send whole, pictures and captions included, as the map of an album is not.
 */
export async function buildActivityMapPayload(viewer: Viewer, activityId: string, tripOpen: boolean): Promise<ActivityMapPayload> {
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
    orderBy: [{ takenAt: "asc" }, { id: "asc" }],
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
    bounds: toPair(b),
    trips: [],
  };
}
