import { db } from "@/lib/db";
import { pickTripByDay, whoWasThere } from "@/lib/photos/assign";
import { pickTripByCoverage } from "@/lib/photos/trip-by-coverage";
import { activityFor } from "@/lib/activities/reassign";
import { localDayFromOffset } from "@/lib/time/local-day";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import type { TakenAtSource } from "@/generated/prisma/enums";

export type DatedPhoto = { id: string; tripId: string | null; gpsSource: string | null; uploaderId: string; activityId: string | null; activitySetById: string | null };

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
  opts: { geotag?: boolean; releaseKeptOff?: boolean; keepActivity?: boolean } = {},
): Promise<string | null> {
  let tripId = photo.tripId;
  if (!tripId) {
    // Only trips this member was on, where anybody said who was on them; a clock cannot tell two families apart.
    const trips = await db.trip.findMany({ where: { deletingAt: null, ...whoWasThere(photo.uploaderId) }, select: { id: true, startDate: true, endDate: true, timezone: true } });
    const day = localDayFromOffset(takenAt, tzOffsetMin);
    tripId = pickTripByDay(trips, day)?.id ?? null;
    // On no trip's days (a ride on the last evening that runs past midnight): the trip out on an activity or a track
    // at that moment.
    if (!tripId && !trips.some((t) => pickTripByDay([t], day))) tripId = (await pickTripByCoverage(trips, photo.uploaderId, () => ({ takenAt, source })))?.id ?? null;
  }
  // An activity a member chose stays chosen: a corrected date does not move a photo out of the walk it was on. One
  // kept off every activity stays off through shifts, bulk corrections and the album's own re-reading of the date;
  // only a member typing (or picking) the one date this photo was taken — `releaseKeptOff` — says when it really
  // was, so that time decides again.
  const keptOff = !photo.activityId && photo.activitySetById !== null;
  // `keepActivity`: a date only known to the day says nothing about which hour's outing it was, so the filing stays
  // as it is (or empty, on a trip it has only just joined).
  const { activityId, activitySetById } = opts.keepActivity
    ? tripId === photo.tripId ? { activityId: photo.activityId, activitySetById: photo.activitySetById } : { activityId: null, activitySetById: null }
    : await activityFor(opts.releaseKeptOff && keptOff ? { ...photo, activitySetById: null } : photo, tripId, takenAt);
  await db.photo.update({
    where: { id: photo.id },
    data: {
      takenAt,
      tzOffsetMin,
      takenAtSource: source,
      dateSetById,
      tripId,
      activityId,
      activitySetById,
      ...(photo.gpsSource === "TRACK" ? { lat: null, lng: null, altitude: null, gpsSource: null } : {}),
    },
  });
  if (tripId && opts.geotag !== false) await requestGeotag(tripId);
  return tripId;
}

export async function requestGeotag(tripId: string): Promise<void> {
  await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true });
}
