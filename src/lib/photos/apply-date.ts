import { db } from "@/lib/db";
import { pickActivityByTime, pickTripByDay } from "@/lib/photos/assign";
import { localDayFromOffset } from "@/lib/time/local-day";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import type { TakenAtSource } from "@/generated/prisma/enums";

export type DatedPhoto = { id: string; tripId: string | null; gpsSource: string | null };

/**
 * Give one item a new instant, and let everything that hangs off a date follow it: which trip it belongs to, which
 * activity it sits inside, and a pin that was interpolated from a track at the old time (which is no longer where
 * the camera was). Returns the trip the item ended up on, so a caller moving many items can ask for one re-geotag
 * per trip rather than one per photo.
 */
export async function applyPhotoInstant(
  photo: DatedPhoto,
  takenAt: Date,
  tzOffsetMin: number,
  source: TakenAtSource,
  dateSetById: string | null,
  opts: { geotag?: boolean } = {},
): Promise<string | null> {
  let tripId = photo.tripId;
  if (!tripId) {
    const trips = await db.trip.findMany({ select: { id: true, startDate: true, endDate: true } });
    tripId = pickTripByDay(trips, localDayFromOffset(takenAt, tzOffsetMin))?.id ?? null;
  }
  let activityId: string | null = null;
  if (tripId) {
    const acts = await db.activity.findMany({ where: { tripId }, select: { id: true, startTime: true, endTime: true } });
    activityId = pickActivityByTime(acts, takenAt)?.id ?? null;
  }
  await db.photo.update({
    where: { id: photo.id },
    data: {
      takenAt,
      tzOffsetMin,
      takenAtSource: source,
      dateSetById,
      tripId,
      activityId,
      ...(photo.gpsSource === "TRACK" ? { lat: null, lng: null, altitude: null, gpsSource: null } : {}),
    },
  });
  if (tripId && opts.geotag !== false) await requestGeotag(tripId);
  return tripId;
}

export async function requestGeotag(tripId: string): Promise<void> {
  await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true });
}
