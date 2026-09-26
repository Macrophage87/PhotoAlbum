import { db } from "@/lib/db";
import { columnarToPoints, decodePoints } from "@/lib/tracks/encode";
import { positionAt, positionKindAt, type PositionKind } from "@/lib/tracks/interpolate";
import type { TrackPoint } from "@/lib/tracks/types";
import type { GeotagPhotosJob } from "../queues";
import type { TakenAtSource } from "@/generated/prisma/enums";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { haversine } from "@/lib/geo/haversine";

/** Within this, the uploader's own Google trace and another member's activity track put them in the same place. */
const TOGETHER_M = 300;
/** A visit's filler sits at the place's centre, which can be well inside somewhere big but not this far from a trail. */
const VISIT_APART_M = 3_000;

type Position = { lat: number; lng: number; ele?: number };
type Fix<T> = { track: T; pos: Position; kind: PositionKind };
type Covering = { startTime: Date; endTime: Date };

/** A track's position at an instant, or null where it does not cover it. */
function positionOn<T extends Covering>(track: T, points: TrackPoint[], tMs: number): Position | null {
  return tMs < track.startTime.getTime() || tMs > track.endTime.getTime() ? null : positionAt(points, tMs);
}

/**
 * The track to place a photo from, and where. The uploader's own GPX/FIT comes first. Then, where the uploader's own
 * Google trace and other members' GPX/FIT cover the moment, the trace is weighed against them:
 * - a recorded position more than TOGETHER_M from every one of them says the uploader was elsewhere (Mom in the
 *   museum while Dad was out on his bike), so the trace places the photo;
 * - a position at a visit's place is judged at the visit's doors: the uploader's last recorded fix before it and
 *   first after it, against each activity track at those same moments. Apart at every door that can be compared
 *   means elsewhere; together at any door means together (the trailhead of a park whose centre is far from the
 *   trail). With no door to compare, the visit's centre must be more than VISIT_APART_M away;
 * - a position snapped across a signal gap, or interpolated by the importer, says nothing.
 * Wherever the uploader was not shown to be elsewhere, the nearest activity track they were with (or simply the
 * nearest), the more precise record, places the photo. After that, the uploader's own Google trace, others' GPX/FIT,
 * others' Google traces. Within each, start-time order.
 */
function choose<T extends Covering & { source: string; uploaderId: string }>(tracks: T[], uploaderId: string, tMs: number, pointsOf: (t: T) => TrackPoint[]): Fix<T> | null {
  const all = (own: boolean, google: boolean, one = false) => {
    const out: Fix<T>[] = [];
    for (const track of tracks) {
      if ((track.uploaderId === uploaderId) !== own || (track.source === "GOOGLE") !== google) continue;
      const pos = positionOn(track, pointsOf(track), tMs);
      if (pos) out.push({ track, pos, kind: positionKindAt(pointsOf(track), tMs) ?? "soft" });
      if (one && out.length) break;
    }
    return out;
  };
  const [ownPrecise] = all(true, false, true);
  if (ownPrecise) return ownPrecise;
  const [ownGoogle] = all(true, true, true);
  const others = all(false, false);
  if (!ownGoogle || !others.length) return ownGoogle ?? others[0] ?? all(false, true, true)[0] ?? null;

  const away = (f: Fix<T>) => haversine(ownGoogle.pos.lat, ownGoogle.pos.lng, f.pos.lat, f.pos.lng);
  const byDistance = [...others].sort((a, b) => away(a) - away(b));
  if (ownGoogle.kind === "firm") return away(byDistance[0]) > TOGETHER_M ? ownGoogle : byDistance[0];
  if (ownGoogle.kind === "soft") return byDistance[0];

  // A visit: compare at its doors.
  const own = pointsOf(ownGoogle.track);
  let k = 0;
  while (k < own.length && own[k].t <= tMs) k++;
  let before: TrackPoint | undefined, after: TrackPoint | undefined;
  for (let i = k - 1; i >= 0 && !before; i--) if (!own[i].filled) before = own[i];
  for (let i = k; i < own.length && !after; i++) if (!own[i].filled) after = own[i];
  const together = (f: Fix<T>) => {
    const doors = [before, after].filter((d): d is TrackPoint => !!d);
    const gaps = doors.flatMap((d) => {
      const p = positionOn(f.track, pointsOf(f.track), d.t);
      return p ? [haversine(d.lat, d.lng, p.lat, p.lng)] : [];
    });
    return gaps.length ? gaps.some((g) => g <= TOGETHER_M) : away(f) <= VISIT_APART_M;
  };
  return byDistance.find(together) ?? ownGoogle;
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
    const chosen = choose(tracks, photo.uploaderId, t, pointsOf);
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
