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
 * The same for a position at a visit's place or one the trace only guesses at (snapped across a gap, or interpolated
 * by the importer). A visit's point is the middle of the place, which can be well inside somewhere big.
 */
const LOOSE_TOGETHER_M = 3_000;

type Position = { lat: number; lng: number; ele?: number };
type Fix<T> = { track: T; pos: Position; kind: PositionKind };

/**
 * The track to place a photo from, and where, judged at the photo's own moment. The uploader's own GPX/FIT comes
 * first. Then, where the uploader's own Google trace and other members' GPX/FIT cover the moment, the trace's position
 * P is compared with the nearest of their positions Q: farther apart than TOGETHER_M (for a recorded P) or
 * LOOSE_TOGETHER_M (for a visit's place or a guessed P), the uploader was elsewhere (Mom in the museum while Dad was
 * out on his bike) and her own trace places the photo; closer, they were together and Q's track, the more precise
 * record, places it. The looser limit has two accepted costs: a city museum within 3 km of Dad's ride puts Mom's
 * photos on his route, and a park so big that its centre is more than 3 km from the trail they walked together puts
 * them at the park's centre.
 * After that, the uploader's own Google trace, others' GPX/FIT, others' Google traces. Within each, start-time order.
 */
function choose<T extends { source: string; uploaderId: string }>(tracks: T[], uploaderId: string, at: (t: T) => Omit<Fix<T>, "track"> | null): Fix<T> | null {
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
  if (ownGoogle && others.length) {
    const away = (f: Fix<T>) => haversine(ownGoogle.pos.lat, ownGoogle.pos.lng, f.pos.lat, f.pos.lng);
    const nearest = others.reduce((a, b) => (away(b) < away(a) ? b : a));
    return away(nearest) > (ownGoogle.kind === "firm" ? TOGETHER_M : LOOSE_TOGETHER_M) ? ownGoogle : nearest;
  }
  return ownGoogle ?? others[0] ?? all(false, true, true)[0] ?? null;
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
    const chosen = choose(tracks, photo.uploaderId, (track) => {
      if (t < track.startTime.getTime() || t > track.endTime.getTime()) return null;
      const pts = pointsOf(track), pos = positionAt(pts, t);
      return pos && { pos, kind: positionKindAt(pts, t) ?? "soft" };
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
