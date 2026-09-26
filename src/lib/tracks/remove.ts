import { db } from "@/lib/db";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

/**
 * Delete a track and take back the positions it may have given photos. Which track placed a photo is not recorded,
 * so every track-placed photo taken inside its window is cleared, and a geotag run puts back whatever the trip's
 * remaining tracks still cover. Otherwise photos stay pinned along a route that no longer exists (the wrong GPX,
 * somebody else's ride) until someone thinks to press "Re-geotag".
 */
export async function deleteTrackAndItsPositions(trackId: string): Promise<void> {
  const track = await db.track.findUnique({ where: { id: trackId }, select: { tripId: true, startTime: true, endTime: true } });
  if (!track) return;
  // The track goes first, so a geotag run already under way cannot place anything on it again.
  const { count } = await db.track.deleteMany({ where: { id: trackId } });
  if (!count) return;
  await db.photo.updateMany({
    where: { tripId: track.tripId, gpsSource: "TRACK", takenAt: { gte: track.startTime, lte: track.endTime } },
    data: { lat: null, lng: null, altitude: null, gpsSource: null },
  });
  await enqueue(QUEUES.geotagPhotos, { tripId: track.tripId }, { singletonKey: `geotag:${track.tripId}`, singletonSeconds: 10, singletonNextSlot: true }).catch(() => undefined);
}
