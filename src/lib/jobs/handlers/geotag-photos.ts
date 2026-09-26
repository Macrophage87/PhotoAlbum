import { db } from "@/lib/db";
import { columnarToPoints, decodePoints } from "@/lib/tracks/encode";
import { positionAt, positionKindAt, type PositionKind } from "@/lib/tracks/interpolate";
import type { TrackPoint } from "@/lib/tracks/types";
import type { GeotagPhotosJob } from "../queues";
import type { TakenAtSource } from "@/generated/prisma/enums";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { haversine } from "@/lib/geo/haversine";

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
const VISIT_STRAY_M = 5_000;

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
 * - P is recorded, and more than TOGETHER_M from all of them;
 * - P is at a visit's place, and no member's track came within LOOSE_TOGETHER_M of that place during the visit
 *   while still being within VISIT_STRAY_M (5 km) of it at the photo's moment (Mom in the museum while Dad was out
 *   on his bike; or Dad rode more than 5 km off after they arrived somewhere together);
 * - P is a guess (snapped across a gap, or interpolated by the importer), and more than LOOSE_TOGETHER_M from all
 *   of them.
 * If she was elsewhere, her own trace places the photo; otherwise the nearest activity track she was with, the more
 * precise record, does. The limits have accepted costs: a city museum Dad rode within 3 km of while she was in it
 * puts her photos on his route; after arriving somewhere together, a photo she takes there once he is 4 km off (inside
 * the 5 km stray limit) goes on his route too; and a park so big that the trail they walked together never came
 * within 3 km of its centre puts them at the centre. After that, the uploader's own Google trace, others' GPX/FIT, others' Google
 * traces. Within each, start-time order.
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
  if (ownGoogle.kind === "soft") return away(byDistance[0]) > LOOSE_TOGETHER_M ? ownGoogle : byDistance[0];

  // A visit: its span is the run of visit points around the moment, its place where they sit.
  let a = lastAtOrBefore(own, tMs), b = a + 1;
  const isVisit = (i: number) => i >= 0 && i < own.length && own[i].filled === "visit";
  const place = isVisit(a) ? own[a] : own[b];
  while (isVisit(a - 1)) a--;
  while (isVisit(b)) b++;
  const spanFrom = own[Math.max(0, a)].t, spanTo = own[Math.min(own.length - 1, b - 1)].t;
  const dist = (p: Position) => haversine(place.lat, place.lng, p.lat, p.lng);
  const wasThere = (f: Fix<T>) => {
    if (dist(f.pos) > VISIT_STRAY_M) return false;
    const pts = f.points;
    for (let i = Math.max(0, lastAtOrBefore(pts, spanFrom)); i < pts.length && pts[i].t <= spanTo; i++) if (pts[i].t >= spanFrom && dist(pts[i]) <= LOOSE_TOGETHER_M) return true;
    for (const edge of [spanFrom, spanTo]) {
      const p = positionAt(pts, edge);
      if (p && dist(p) <= LOOSE_TOGETHER_M) return true;
    }
    return false;
  };
  return byDistance.find(wasThere) ?? ownGoogle;
}

/** Only timestamps that came from the camera (or were set by hand) are trustworthy enough to place a photo on a track. */
const TRUSTED_TIME_SOURCES: TakenAtSource[] = ["EXIF_OFFSET", "EXIF_TZLOOKUP", "TRIP_TZ", "MANUAL", "SIDECAR"];

/**
 * Give GPS-less photos a position by interpolating along any track that covers the moment they were taken.
 * Never overwrites EXIF or manual positions; a place the AI helper guessed at is replaced, since a track is a
 * record and the guess is not. The uploader's own tracks are preferred over other members', and activity
 * tracks (GPX/FIT) over Google traces. When a GPX/FIT track is imported later, photos previously placed inside its
 * time window are looked at again, and so are the uploader's own photos inside a newly imported Google trace, so
 * each ends up on the best track that covers it.
 */
export async function geotagPhotos(job: GeotagPhotosJob): Promise<{ updated: number }> {
  // Every track of the trip is a candidate; the job's own (newly imported) tracks decide which placed photos are
  // worth looking at again.
  const tracks = await db.track.findMany({
    where: { tripId: job.tripId },
    select: { id: true, source: true, uploaderId: true, startTime: true, endTime: true, pointsBlob: true },
    orderBy: { startTime: "asc" },
  });
  if (!tracks.length) return { updated: 0 };
  const fresh = job.trackIds?.length ? tracks.filter((t) => job.trackIds!.includes(t.id)) : tracks;
  if (!fresh.length) return { updated: 0 };
  const window = (t: (typeof tracks)[number]) => ({ takenAt: { gte: t.startTime, lte: t.endTime } });

  const trusted = { takenAt: { not: null }, takenAtSource: { in: TRUSTED_TIME_SOURCES } };
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
    select: { id: true, uploaderId: true, takenAt: true, gpsSource: true, lat: true, lng: true, altitude: true },
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

  let updated = 0;
  for (const photo of photos) {
    const t = photo.takenAt!.getTime();
    const chosen = choose(tracks, photo.uploaderId, t, (track) => {
      if (t < track.startTime.getTime() || t > track.endTime.getTime()) return null;
      const points = pointsOf(track), pos = positionAt(points, t);
      return pos && { pos, kind: positionKindAt(points, t) ?? "soft", points };
    });
    if (chosen) {
      const { track, pos } = chosen;
      const same = photo.gpsSource === "TRACK" && photo.lat === pos.lat && photo.lng === pos.lng && (photo.altitude ?? null) === (pos.ele ?? null);
      if (same) continue;
      // Only while the track still exists: one deleted during this run has had its positions taken back already.
      const r = await db.photo.updateMany({
        // And only while the photo is as it was read: a member may have placed it by hand while this ran.
        where: { id: photo.id, gpsSource: photo.gpsSource, trip: { tracks: { some: { id: track.id } } } },
        data: { lat: pos.lat, lng: pos.lng, altitude: pos.ele ?? null, gpsSource: "TRACK" },
      });
      updated += r.count;
    }
  }
  if (updated) console.log(`[geotag-photos] positioned ${updated} photo(s) on trip ${job.tripId}`);
  return { updated };
}
