import { db } from "@/lib/db";
import { columnarToPoints, decodePoints } from "@/lib/tracks/encode";
import { positionAt } from "@/lib/tracks/interpolate";
import type { TrackPoint } from "@/lib/tracks/types";
import type { GeotagPhotosJob } from "../queues";
import type { TakenAtSource } from "@/generated/prisma/enums";

/** Only timestamps that came from the camera (or were set by hand) are trustworthy enough to place a photo on a track. */
const TRUSTED_TIME_SOURCES: TakenAtSource[] = ["EXIF_OFFSET", "EXIF_TZLOOKUP", "TRIP_TZ", "MANUAL"];

/**
 * Give GPS-less photos a position by interpolating along any track that covers the moment they were taken.
 * Never overwrites EXIF or manual positions. Activity tracks (GPX/FIT) are preferred over Google traces,
 * and when a GPX/FIT track is imported later, photos previously placed from a coarser trace inside its
 * time window are re-positioned from it.
 */
export async function geotagPhotos(job: GeotagPhotosJob): Promise<{ updated: number }> {
  const tracks = await db.track.findMany({
    where: { tripId: job.tripId, ...(job.trackIds?.length ? { id: { in: job.trackIds } } : {}) },
    select: { id: true, source: true, startTime: true, endTime: true, pointsBlob: true },
    orderBy: { startTime: "asc" },
  });
  if (!tracks.length) return { updated: 0 };
  // GPX/FIT first so a real activity track wins over a coarse Google trace covering the same time.
  tracks.sort((a, b) => (a.source === "GOOGLE" ? 1 : 0) - (b.source === "GOOGLE" ? 1 : 0));
  const precise = tracks.filter((t) => t.source !== "GOOGLE");

  const trusted = { takenAt: { not: null }, takenAtSource: { in: TRUSTED_TIME_SOURCES } };
  const photos = await db.photo.findMany({
    where: {
      tripId: job.tripId,
      OR: [
        { lat: null, gpsSource: null, ...trusted },
        // Already placed from a track: re-evaluate only inside the windows of newly available precise tracks.
        ...(precise.length ? [{ gpsSource: "TRACK" as const, ...trusted, OR: precise.map((t) => ({ takenAt: { gte: t.startTime, lte: t.endTime } })) }] : []),
      ],
    },
    select: { id: true, takenAt: true, gpsSource: true },
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
    // A photo that already has a track position is only moved by a precise (non-Google) track.
    const candidates = photo.gpsSource === "TRACK" ? precise : tracks;
    for (const track of candidates) {
      if (t < track.startTime.getTime() || t > track.endTime.getTime()) continue;
      const pos = positionAt(pointsOf(track), t);
      if (!pos) continue;
      await db.photo.update({ where: { id: photo.id }, data: { lat: pos.lat, lng: pos.lng, altitude: pos.ele ?? null, gpsSource: "TRACK" } });
      updated++;
      break;
    }
  }
  if (updated) console.log(`[geotag-photos] positioned ${updated} photo(s) on trip ${job.tripId}`);
  return { updated };
}
