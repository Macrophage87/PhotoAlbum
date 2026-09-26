import { db } from "@/lib/db";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { hasLiveProcessingJob } from "@/lib/jobs/live";

/** Past pg-boss's own retries of a failed processing job (two, thirty seconds apart and backing off). */
const FAILED_SETTLED_MS = 5 * 60_000;
/** Longer than any processing job can still hold a photo, retries included (four 15-minute job expiries). */
const PENDING_STUCK_MS = 60 * 60_000;

type Stuck = { id: string; kind: string; tripId: string | null; status: string; originalPath: string; updatedAt: Date };

/**
 * Queue processing again for a photo that has its file but never became a picture: one that FAILED (and that
 * pg-boss has stopped retrying), or one still PENDING an hour on with no job waiting for it (the process died between
 * storing it and queueing it). Found when the same file arrives again, which is when somebody is waiting to see it.
 * Returns whether it was queued.
 */
export async function processAgainIfStuck(photo: Stuck, opts: { now?: number; liveJob?: (id: string) => Promise<boolean> } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (photo.originalPath === "pending") return false;
  const age = now - photo.updatedAt.getTime();
  const old = photo.status === "FAILED" ? age > FAILED_SETTLED_MS : photo.status === "PENDING" && age > PENDING_STUCK_MS;
  // And no job for it waiting, running or due a retry: that one will get there by itself.
  if (!old || (await (opts.liveJob ?? hasLiveProcessingJob)(photo.id))) return false;
  // Conditional on nothing having touched it since it was read, so two arrivals of the same file queue it once.
  const claimed = await db.photo.updateMany({ where: { id: photo.id, status: photo.status as never, updatedAt: photo.updatedAt }, data: { status: "PENDING", error: null } });
  if (claimed.count !== 1) return false;
  try {
    // Once only: the live-job check above and the conditional write just made are what keep it to one.
    if (photo.kind === "VIDEO") await enqueue(QUEUES.transcodeVideo, { photoId: photo.id, tripId: photo.tripId });
    else await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: photo.tripId });
    return true;
  } catch (err) {
    console.error("[media] could not queue processing again", err);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: "Could not queue processing; use Re-process on the photo page." } }).catch(() => undefined);
    return false;
  }
}
