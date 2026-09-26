import { db } from "@/lib/db";
import { columnarToPoints, decodePoints } from "@/lib/tracks/encode";
import { positionAt } from "@/lib/tracks/interpolate";
import type { TrackPoint } from "@/lib/tracks/types";
import type { GeotagPhotosJob } from "../queues";
import type { TakenAtSource } from "@/generated/prisma/enums";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { haversine } from "@/lib/geo/haversine";

/** Within this, the uploader's own Google trace and another member's activity track put them in the same place. */
const TOGETHER_M = 300;

type Position = { lat: number; lng: number; ele?: number };

/**
 * The track to place a photo from, and where. The uploader's own GPX/FIT comes first. Then, where the uploader's own
 * Google trace and another member's GPX/FIT both cover the moment, the two are compared: within TOGETHER_M they were
 * together and the activity track is the more precise record of where; farther apart they were not, and the
 * uploader's own trace says where the photo was taken (Mom in the museum while Dad was out on his bike). After that,
 * the uploader's own Google trace, others' GPX/FIT, others' Google traces. Within each, start-time order.
 */
function choose<T extends { source: string; uploaderId: string }>(tracks: T[], uploaderId: string, at: (t: T) => Position | null): { track: T; pos: Position } | null {
  const first = (own: boolean, google: boolean) => {
    for (const track of tracks) {
      if ((track.uploaderId === uploaderId) !== own || (track.source === "GOOGLE") !== google) continue;
      const pos = at(track);
      if (pos) return { track, pos };
    }
    return null;
  };
  const ownPrecise = first(true, false);
  if (ownPrecise) return ownPrecise;
  const ownGoogle = first(true, true), otherPrecise = first(false, false);
  if (ownGoogle && otherPrecise) {
    return haversine(ownGoogle.pos.lat, ownGoogle.pos.lng, otherPrecise.pos.lat, otherPrecise.pos.lng) <= TOGETHER_M ? otherPrecise : ownGoogle;
  }
  return ownGoogle ?? otherPrecise ?? first(false, true);
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
    const chosen = choose(tracks, photo.uploaderId, (track) => (t < track.startTime.getTime() || t > track.endTime.getTime() ? null : positionAt(pointsOf(track), t)));
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
