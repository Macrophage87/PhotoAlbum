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
 * - after arriving somewhere together, a photo she takes there within the hour after he leaves, while he is still
 *   within 8 km, goes on his route too;
 * - a park so big that the trail they walked together stayed more than 3 km from its centre for the whole hour around
 *   the photo puts it at the centre.
 * After that, the uploader's own Google trace, others' GPX/FIT, others' Google traces. Within each, start-time order.
 */
function choose<T extends { id: string; source: string; uploaderId: string }>(tracks: T[], uploaderId: string, tMs: number, at: (t: T) => Omit<Fix<T>, "track"> | null, memo: VisitMemo): Fix<T> | null {
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
  const k = lastAtOrBefore(own, tMs);
  const vi = own[k]?.filled === "visit" ? k : k + 1;
  const { from: spanFrom, to: spanTo } = memo.visitSpan(ownGoogle.track, own, vi);
  const place = own[vi];
  const nearFrom = Math.max(spanFrom, tMs - VISIT_NEAR_MS), nearTo = Math.min(spanTo, tMs + VISIT_NEAR_MS);
  const dist = (p: Position) => haversine(place.lat, place.lng, p.lat, p.lng);
  const wasThere = (f: Fix<T>) => {
    if (dist(f.pos) > VISIT_STRAY_M) return false;
    if (memo.nearestApproach(ownGoogle.track, spanFrom, spanTo, place, f.track, f.points, nearFrom, nearTo) <= LOOSE_TOGETHER_M) return true;
    // Between his fixes, at the window's own edges.
    for (const edge of [nearFrom, nearTo]) {
      const p = positionAt(f.points, edge);
      if (p && dist(p) <= LOOSE_TOGETHER_M) return true;
    }
    return false;
  };
  return byDistance.find(wasThere) ?? ownGoogle;
}

/** Range minimum over a fixed array in O(1) per query, after O(n log n) set-up. */
class SparseMin {
  private readonly levels: Float64Array[];
  constructor(values: number[]) {
    this.levels = [Float64Array.from(values)];
    for (let w = 1; 2 * w <= values.length; w *= 2) {
      const prev = this.levels[this.levels.length - 1], next = new Float64Array(prev.length - w);
      for (let i = 0; i < next.length; i++) next[i] = Math.min(prev[i], prev[i + w]);
      this.levels.push(next);
    }
  }
  /** Minimum of values[lo..hi] inclusive; Infinity for an empty range. */
  min(lo: number, hi: number): number {
    if (lo > hi) return Infinity;
    const k = 31 - Math.clz32(hi - lo + 1);
    return Math.min(this.levels[k][lo], this.levels[k][hi - (1 << k) + 1]);
  }
}

/**
 * What one geotag run works out once and asks about for many photos: the visit spans in each Google trace, and each
 * other track's distance to a visit's place at every one of its fixes inside that visit.
 */
function visitMemo() {
  const spans = new Map<string, { start: Int32Array; end: Int32Array }>();
  const approaches = new Map<string, { times: number[]; min: SparseMin }>();
  return {
    visitSpan(track: { id: string }, points: TrackPoint[], i: number): { from: number; to: number } {
      let run = spans.get(track.id);
      if (!run) {
        const n = points.length, start = new Int32Array(n), end = new Int32Array(n);
        for (let j = 0; j < n; j++) start[j] = j > 0 && points[j - 1].filled === "visit" && points[j].filled === "visit" ? start[j - 1] : j;
        for (let j = n - 1; j >= 0; j--) end[j] = j < n - 1 && points[j + 1].filled === "visit" && points[j].filled === "visit" ? end[j + 1] : j;
        run = { start, end };
        spans.set(track.id, run);
      }
      return { from: points[run.start[i]].t, to: points[run.end[i]].t };
    },
    /** His nearest approach to the visit's place at his own fixes between `from` and `to` (inside the visit's span). */
    nearestApproach(own: { id: string }, spanFrom: number, spanTo: number, place: Position, other: { id: string }, points: TrackPoint[], from: number, to: number): number {
      const key = `${own.id}:${spanFrom}:${spanTo}:${place.lat}:${place.lng}:${other.id}`;
      let a = approaches.get(key);
      if (!a) {
        const times: number[] = [], dists: number[] = [];
        for (let i = Math.max(0, lastAtOrBefore(points, spanFrom)); i < points.length && points[i].t <= spanTo; i++) {
          if (points[i].t < spanFrom) continue;
          times.push(points[i].t);
          dists.push(haversine(place.lat, place.lng, points[i].lat, points[i].lng));
        }
        a = { times, min: new SparseMin(dists) };
        approaches.set(key, a);
      }
      const lo = firstAtOrAfter(a.times, from), hi = lastAtOrBeforeTime(a.times, to);
      return a.min.min(lo, hi);
    },
  };
}
type VisitMemo = ReturnType<typeof visitMemo>;

function firstAtOrAfter(times: number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lastAtOrBeforeTime(times: number[], t: number): number {
  return firstAtOrAfter(times, t + 1) - 1;
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

  const memo = visitMemo();
  let updated = 0;
  for (const photo of photos) {
    const t = photo.takenAt!.getTime();
    const chosen = choose(tracks, photo.uploaderId, t, (track) => {
      if (t < track.startTime.getTime() || t > track.endTime.getTime()) return null;
      const points = pointsOf(track), pos = positionAt(points, t);
      return pos && { pos, kind: positionKindAt(points, t) ?? "soft", points };
    }, memo);
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
