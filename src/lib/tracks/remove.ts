import { db } from "@/lib/db";
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
 * `placeAgain: false` is for a caller that deletes several and runs geotagging once itself afterwards.
 */
export async function deleteTrackAndItsPositions(trackId: string, opts: { placeAgain?: boolean } = {}): Promise<void> {
  const track = await db.track.findUnique({ where: { id: trackId }, select: { tripId: true, startTime: true, endTime: true } });
  if (!track) return;
  const [{ count }] = await db.$transaction([
    db.track.deleteMany({ where: { id: trackId } }),
    db.photo.updateMany({
      where: { tripId: track.tripId, gpsSource: "TRACK", takenAt: { gte: track.startTime, lte: track.endTime } },
      data: { lat: null, lng: null, altitude: null, gpsSource: null },
    }),
  ]);
  if (!count || opts.placeAgain === false) return;
  // A trip's photos are few enough to place again here; the queue is only a fallback if that fails.
  try {
    await geotagPhotos({ tripId: track.tripId });
  } catch (err) {
    console.error(`[tracks] re-placing photos after deleting track ${trackId} failed; queueing a geotag run`, err);
    await enqueue(QUEUES.geotagPhotos, { tripId: track.tripId }, { singletonKey: `geotag:${track.tripId}`, singletonSeconds: 10, singletonNextSlot: true });
  }
}
