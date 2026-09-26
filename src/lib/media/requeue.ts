import { db } from "@/lib/db";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

/** Past pg-boss's own retries of a failed processing job (two, thirty seconds apart and backing off). */
const FAILED_SETTLED_MS = 5 * 60_000;
/** Longer than any processing job can still hold a photo, retries included (four 15-minute job expiries). */
const PENDING_STUCK_MS = 60 * 60_000;

type Stuck = { id: string; kind: string; tripId: string | null; status: string; originalPath: string; updatedAt: Date };

/**
 * Is a processing job for this photo waiting or running? A photo can sit PENDING for a long time behind a big
 * import, and that is not stuck. Unknown (pg-boss's tables unreadable) counts as yes, so nothing is queued twice.
 */
export async function hasLiveProcessingJob(photoId: string): Promise<boolean> {
  try {
    const rows = await db.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM pgboss.job
      WHERE name IN (${QUEUES.processPhoto}, ${QUEUES.transcodeVideo}) AND state IN ('created', 'retry', 'active') AND data->>'photoId' = ${photoId}
      LIMIT 1`;
    return rows.length > 0;
  } catch {
    return true;
  }
}

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
  // A FAILED one past pg-boss's retries has no job left; a PENDING one may simply be waiting its turn, so ask.
  const stuck = photo.status === "FAILED" ? age > FAILED_SETTLED_MS : photo.status === "PENDING" && age > PENDING_STUCK_MS && !(await (opts.liveJob ?? hasLiveProcessingJob)(photo.id));
  if (!stuck) return false;
  // Conditional on nothing having touched it since it was read, so two arrivals of the same file queue it once.
  const claimed = await db.photo.updateMany({ where: { id: photo.id, status: photo.status as never, updatedAt: photo.updatedAt }, data: { status: "PENDING", error: null } });
  if (claimed.count !== 1) return false;
  try {
    // Keyed like every other re-queue of the same photo, so pg-boss holds at most one of them waiting.
    if (photo.kind === "VIDEO") await enqueue(QUEUES.transcodeVideo, { photoId: photo.id, tripId: photo.tripId }, { singletonKey: `transcode:${photo.id}` });
    else await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: photo.tripId }, { singletonKey: `process:${photo.id}` });
    return true;
  } catch (err) {
    console.error("[media] could not queue processing again", err);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: "Could not queue processing; use Re-process on the photo page." } }).catch(() => undefined);
    return false;
  }
}
