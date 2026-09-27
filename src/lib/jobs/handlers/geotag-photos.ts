import { db } from "@/lib/db";
import { columnarToPoints, decodePoints } from "@/lib/tracks/encode";
import { positionAt, positionKindAt, type PositionKind } from "@/lib/tracks/interpolate";
import type { TrackPoint } from "@/lib/tracks/types";
import type { GeotagPhotosJob } from "../queues";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { TRUSTED_TIME_SOURCES } from "@/lib/photos/date-from-neighbours";
import { haversine } from "@/lib/geo/haversine";
import { openTo } from "@/lib/photos/assign";

/** A recorded position of the uploader's own farther than this from another member's activity track: not together. */
const TOGETHER_M = 300;
/**
 * The same for a position the trace only guesses at (snapped across a gap, or interpolated by the importer), and how
 * near another member's track must come to a visit's place, during the visit, to have been there with the uploader.
 * A visit's point is the middle of the place, which can be well inside somewhere big.
 */
const LOOSE_TOGETHER_M = 3_000;
/**
 * However near they came during a visit, a member this far from its place at the photo's moment had left: a photo on
 * his route that far from where she sat would be too wrong, while a park hike still wanders a few kilometres from
 * the park's centre.
 */
const VISIT_STRAY_M = 8_000;
/** How long either side of the photo a member's track must have come near a visit's place to have been there with her. */
const VISIT_NEAR_MS = 60 * 60_000;

type Position = { lat: number; lng: number; ele?: number };
type Fix<T> = { track: T; pos: Position; kind: PositionKind; points: TrackPoint[] };

/** Index of the last point at or before tMs (-1 if none). */
function lastAtOrBefore(points: TrackPoint[], tMs: number): number {
  let lo = 0, hi = points.length - 1, out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= tMs) {
      out = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return out;
}

/**
 * The track to place a photo from, and where. The uploader's own GPX/FIT comes first. Then, where the uploader's own
 * Google trace (position P) and other members' GPX/FIT cover the moment, the uploader was with one of them unless:
 * - P is recorded, and more than TOGETHER_M (300 m) from all of them;
 * - P is at a visit's place, and no member's track both came within LOOSE_TOGETHER_M (3 km) of that place within an
 *   hour of the photo (and inside the visit) and is within VISIT_STRAY_M (8 km) of it at the photo's moment (Mom in
 *   the museum while Dad was out on his bike; or Dad rode off after they arrived somewhere together);
 * - P is a guess (snapped across a gap, or interpolated by the importer), and more than 3 km from all of them.
 * If she was elsewhere, her own trace places the photo; otherwise the nearest activity track she was with, the more
 * precise record, does. The limits have accepted costs:
 * - a city museum Dad rode within 3 km of in the hour around her photo, while staying within 8 km, puts the photo on
 *   his route;
 * - after arriving somewhere together, a photo she takes there goes on his route until he has been more than 3 km
 *   from the place for the hour around the photo, or is more than 8 km off;
 * - a park so big that the trail they walked together stayed more than 3 km from its centre for the whole hour around
 *   the photo puts it at the centre.
 * After that, the uploader's own Google trace, others' GPX/FIT, others' Google traces. Within each, start-time order.
 */
function choose<T extends { source: string; uploaderId: string }>(tracks: T[], uploaderId: string, tMs: number, at: (t: T) => Omit<Fix<T>, "track"> | null): Fix<T> | null {
  const all = (own: boolean, google: boolean, one = false) => {
    const out: Fix<T>[] = [];
    for (const track of tracks) {
      if ((track.uploaderId === uploaderId) !== own || (track.source === "GOOGLE") !== google) continue;
      const fix = at(track);
      if (fix) out.push({ track, ...fix });
      if (one && out.length) break;
    }
    return out;
  };
  const [ownPrecise] = all(true, false, true);
  if (ownPrecise) return ownPrecise;
  const [ownGoogle] = all(true, true, true);
  const others = all(false, false);
  if (!ownGoogle || !others.length) return ownGoogle ?? others[0] ?? all(false, true, true)[0] ?? null;

  const from = (p: Position) => (f: Fix<T>) => haversine(p.lat, p.lng, f.pos.lat, f.pos.lng);
  const away = from(ownGoogle.pos);
  const byDistance = [...others].sort((a, b) => away(a) - away(b));
  const own = ownGoogle.points;

  if (ownGoogle.kind === "firm") return away(byDistance[0]) > TOGETHER_M ? ownGoogle : byDistance[0];

  // A guess defers only to a track close to it: never to one any distance away.
  const asGuess = () => (away(byDistance[0]) > LOOSE_TOGETHER_M ? ownGoogle : byDistance[0]);
  if (ownGoogle.kind === "soft") return asGuess();

  // A visit: its span is the run of visit points around the moment, its place where they sit. A visit position is
  // drawn from a visit point at or just after the moment; should neither be one (the trace's last point, say), there
  // is no place to judge by, and the position is taken as a guess.
  const k = lastAtOrBefore(own, tMs);
  const vi = own[k]?.filled === "visit" ? k : own[k + 1]?.filled === "visit" ? k + 1 : -1;
  if (vi < 0) return asGuess();
  let first = vi, last = vi;
  while (first > 0 && own[first - 1].filled === "visit") first--;
  while (last + 1 < own.length && own[last + 1].filled === "visit") last++;
  const place = own[vi];
  const nearFrom = Math.max(own[first].t, tMs - VISIT_NEAR_MS), nearTo = Math.min(own[last].t, tMs + VISIT_NEAR_MS);
  const dist = (p: Position) => haversine(place.lat, place.lng, p.lat, p.lng);
  // His nearest approach to the place in the hour either side of the photo (inside the visit): his own fixes in that
  // window, and where he was at its edges. A direct scan per photo, so nothing grows with the number of photos.
  // Over a few kilometres the flat-earth distance is within a fraction of a percent of the great-circle one, and
  // needs no trigonometry per fix: this loop can run over thousands of fixes for each of thousands of photos.
  const mPerLat = 111_195, mPerLng = mPerLat * Math.cos((place.lat * Math.PI) / 180), limit2 = LOOSE_TOGETHER_M * LOOSE_TOGETHER_M;
  const cameNear = (points: TrackPoint[]) => {
    for (let i = firstAtOrAfter(points, nearFrom); i < points.length && points[i].t <= nearTo; i++) {
      const dy = (points[i].lat - place.lat) * mPerLat, dx = (points[i].lng - place.lng) * mPerLng;
      if (dx * dx + dy * dy <= limit2) return true;
    }
    // `points` is another member's activity track here (never a Google trace), so a stop on it counts.
    for (const edge of [nearFrom, nearTo]) {
      const p = positionAt(points, edge, { stops: true });
      if (p && dist(p) <= LOOSE_TOGETHER_M) return true;
    }
    return false;
  };
  const wasThere = (f: Fix<T>) => dist(f.pos) <= VISIT_STRAY_M && cameNear(f.points);
  return byDistance.find(wasThere) ?? ownGoogle;
}

function firstAtOrAfter(points: TrackPoint[], t: number): number {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Give GPS-less photos a position by interpolating along any track that covers the moment they were taken.
 * Never overwrites EXIF or manual positions, nor fills one a member cleared by hand; a place the AI helper guessed
 * at is replaced, since a track is a record and the guess is not. The uploader's own tracks are preferred over other
 * members', and activity tracks (GPX/FIT) over Google traces. When a GPX/FIT track is imported later, photos
 * previously placed inside its time window are looked at again, and so are the uploader's own photos inside a newly
 * imported Google trace, so each ends up on the best track that covers it.
 */
export async function geotagPhotos(job: GeotagPhotosJob): Promise<{ updated: number }> {
  // Every track of the trip is a candidate; the job's own (newly imported) tracks decide which placed photos are
  // worth looking at again.
  const tracks = await db.track.findMany({
    where: { tripId: job.tripId },
    select: { id: true, source: true, uploaderId: true, startTime: true, endTime: true, pointsBlob: true, activity: { select: { participants: { select: { id: true } } } } },
    orderBy: { startTime: "asc" },
  });
  // Another member's track places only the photographs of those its activity names, where it names anybody: a ride
  // Dad did with one of the children says nothing about where Mom was, however well it covers her photo's moment.
  // One with no activity, or nobody named, stays everybody's, as before. The uploader's own track is always theirs.
  const onIt = (track: (typeof tracks)[number], uploaderId: string) =>
    track.uploaderId === uploaderId || !track.activity || openTo([track.activity], uploaderId).length > 0;
  if (!tracks.length) return { updated: 0 };
  const fresh = job.trackIds?.length ? tracks.filter((t) => job.trackIds!.includes(t.id)) : tracks;
  if (!fresh.length) return { updated: 0 };
  const window = (t: (typeof tracks)[number]) => ({ takenAt: { gte: t.startTime, lte: t.endTime } });

  // A place a member cleared by hand (placeSetById with no position) stays cleared: it is not a gap to fill.
  const trusted = { takenAt: { not: null }, takenAtSource: { in: TRUSTED_TIME_SOURCES }, placeSetById: null };
  const photos = await db.photo.findMany({
    where: {
      tripId: job.tripId,
      ...NOT_TRASHED,
      OR: [
        { lat: null, gpsSource: null, ...trusted },
        // A place the helper recognised is a guess; a track that covers the moment is a record, so it wins.
        { gpsSource: "ESTIMATE" as const, ...trusted },
        // Already placed from a track: looked at again inside a new activity track's hours, or inside a new Google
        // trace's hours when it is the uploader's own.
        { gpsSource: "TRACK" as const, ...trusted, OR: fresh.map((t) => (t.source === "GOOGLE" ? { uploaderId: t.uploaderId, ...window(t) } : window(t))) },
      ],
    },
    select: { id: true, uploaderId: true, takenAt: true, gpsSource: true, lat: true, lng: true, altitude: true, placeEstimateName: true },
  });
  if (!photos.length) return { updated: 0 };

  const cache = new Map<string, TrackPoint[]>();
  const pointsOf = (t: (typeof tracks)[number]) => {
    let pts = cache.get(t.id);
    if (!pts) {
      pts = columnarToPoints(decodePoints(t.pointsBlob), t.startTime);
      cache.set(t.id, pts);
    }
    return pts;
  };

  let updated = 0, cleared = 0;
  for (const photo of photos) {
    const t = photo.takenAt!.getTime();
    const chosen = choose(tracks.filter((track) => onIt(track, photo.uploaderId)), photo.uploaderId, t, (track) => {
      if (t < track.startTime.getTime() || t > track.endTime.getTime()) return null;
      // An auto-paused stop is read as one only on an activity's track (see STOP_RADIUS_M).
      const points = pointsOf(track), reading = { stops: track.source !== "GOOGLE" };
      const pos = positionAt(points, t, reading);
      return pos && { pos, kind: positionKindAt(points, t, reading) ?? "soft", points };
    });
    if (chosen) {
      const { track, pos } = chosen;
      const same = photo.gpsSource === "TRACK" && photo.lat === pos.lat && photo.lng === pos.lng && (photo.altitude ?? null) === (pos.ele ?? null);
      if (same) continue;
      const r = await db.photo.updateMany({
        // Written only while the photo is still in the state it was chosen in (a member may have pinned or placed it by
        // hand while this ran), and only while the track still exists: one deleted during this run has had its
        // positions taken back already.
        where: {
          id: photo.id,
          takenAt: photo.takenAt,
          placeSetById: null,
          ...(photo.gpsSource === null ? { lat: null, gpsSource: null } : { gpsSource: photo.gpsSource }),
          trip: { tracks: { some: { id: track.id } } },
        },
        data: { lat: pos.lat, lng: pos.lng, altitude: pos.ele ?? null, gpsSource: "TRACK" },
      });
      updated += r.count;
    } else if (photo.gpsSource === "TRACK") {
      // Placed from a track that may no longer place it: somebody's ride whose activity has since named who was on
      // it, and not this uploader. No track of the trip gives it a place now, so the one it has is taken back, under
      // the same guard as placing it; a guess it replaced is asked for again, as when a track is deleted.
      const r = await db.photo.updateMany({
        where: { id: photo.id, takenAt: photo.takenAt, placeSetById: null, gpsSource: "TRACK" },
        data: { lat: null, lng: null, altitude: null, gpsSource: null, ...(photo.placeEstimateName !== null ? { placeEstimatedAt: null } : {}) },
      });
      cleared += r.count;
    }
  }
  if (cleared) console.log(`[geotag-photos] took back ${cleared} track position(s) no track gives any more on trip ${job.tripId}`);
  if (updated) console.log(`[geotag-photos] positioned ${updated} photo(s) on trip ${job.tripId}`);
  return { updated };
}
