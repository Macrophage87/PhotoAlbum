import { db } from "@/lib/db";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

/** Longer than any processing job can still hold a photo, retries included: four 15-minute job expiries, as
 * reconcileStalePhotos reckons it. */
const STUCK_AFTER_MS = 60 * 60_000;

type Stuck = { id: string; kind: string; tripId: string | null; status: string; originalPath: string; updatedAt: Date };

/**
 * Queue processing again for a photo that has its file but never became a picture: one that FAILED, or one still
 * PENDING long after any job for it could be running (the process died between storing it and queueing it). Found
 * when the same file arrives again, which is when somebody is waiting to see it. Returns whether it was queued.
 */
export async function processAgainIfStuck(photo: Stuck, now = Date.now()): Promise<boolean> {
  if (photo.originalPath === "pending") return false;
  const stuck = photo.status === "FAILED" || (photo.status === "PENDING" && now - photo.updatedAt.getTime() > STUCK_AFTER_MS);
  if (!stuck) return false;
  // Conditional, so two arrivals of the same file at once queue it once.
  const claimed = await db.photo.updateMany({ where: { id: photo.id, status: photo.status as never, updatedAt: photo.updatedAt }, data: { status: "PENDING", error: null } });
  if (claimed.count !== 1) return false;
  try {
    if (photo.kind === "VIDEO") await enqueue(QUEUES.transcodeVideo, { photoId: photo.id, tripId: photo.tripId });
    else await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: photo.tripId });
    return true;
  } catch (err) {
    console.error("[media] could not queue processing again", err);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: "Could not queue processing; use Re-process on the photo page." } }).catch(() => undefined);
    return false;
  }
}
