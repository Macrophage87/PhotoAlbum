import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { geotagPhotos } from "@/lib/jobs/handlers/geotag-photos";

/**
 * Delete a track and take back the positions it may have given photos. Which track placed a photo is not recorded,
 * so every track-placed photo of the trip taken inside its hours is cleared in the same transaction, and then placed
 * again at once from whatever tracks the trip still has. Otherwise photos stay pinned along a route that no longer
 * exists (the wrong GPX, somebody else's ride) until someone thinks to press "Re-geotag".
 *
 * Photos in the trash are cleared too: the position was worked out from the track, not recorded with the photo, and
 * restoring from the trash asks for a geotag run that places them again.
 *
 */
export async function deleteTrackAndItsPositions(trackId: string): Promise<void> {
  const track = await db.track.findUnique({ where: { id: trackId }, select: { id: true, tripId: true, startTime: true, endTime: true } });
  if (!track) return;
  if (!(await db.$transaction((tx) => takeBackTrack(tx, track)))) return;
  await placeAgain(track.tripId);
}

/**
 * The deletion itself, inside the caller's transaction: the track goes, and the track-placed positions inside its
 * hours go with it. False when the track was already gone. The caller places photos again once it has committed.
 *
 * A position a track gave may have replaced the helper's guess at the place (see geotag-photos), which is not kept
 * underneath it. Such a photo is marked as not yet asked, so that if no other track places it again, the helper is
 * asked again rather than the photo being left with no place for good; one placed again has a position, and is not.
 */
export async function takeBackTrack(tx: Prisma.TransactionClient, track: { id: string; tripId: string; startTime: Date; endTime: Date }): Promise<boolean> {
  const { count } = await tx.track.deleteMany({ where: { id: track.id } });
  if (!count) return false;
  const placed = { tripId: track.tripId, gpsSource: "TRACK" as const, takenAt: { gte: track.startTime, lte: track.endTime } };
  const cleared = { lat: null, lng: null, altitude: null, gpsSource: null };
  // A guess was placed once (it has a name); the ask is recorded even where the helper declined, which has none.
  await tx.photo.updateMany({ where: { ...placed, placeEstimateName: { not: null } }, data: { ...cleared, placeEstimatedAt: null } });
  await tx.photo.updateMany({ where: placed, data: cleared });
  return true;
}

/** A trip's photos are few enough to place again here; the queue is only a fallback if that fails. */
export async function placeAgain(tripId: string): Promise<void> {
  try {
    await geotagPhotos({ tripId });
  } catch (err) {
    console.error(`[tracks] re-placing photos on trip ${tripId} failed; queueing a geotag run`, err);
    await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true });
  }
}
