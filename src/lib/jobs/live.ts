import { db } from "@/lib/db";
import { QUEUES } from "./queues";

/**
 * Is a processing job for this photo waiting, running, or due a retry? A photo can sit PENDING for a long time behind
 * a big import, and a FAILED one may still have a retry coming; neither is stuck. Unknown (pg-boss's tables
 * unreadable) counts as yes, so nothing is ever queued twice.
 */
export async function hasLiveProcessingJob(photoId: string): Promise<boolean> {
  try {
    const rows = await db.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM pgboss.job
      WHERE name IN (${QUEUES.processPhoto}, ${QUEUES.transcodeVideo}) AND state IN ('created', 'retry', 'active') AND data->>'photoId' = ${photoId}
      LIMIT 1`;
    return rows.length > 0;
  } catch (err) {
    console.error("[jobs] could not read pg-boss's jobs; treating the photo as still queued", err);
    return true;
  }
}

/**
 * The uploaded files (imports/…) that an import job waiting, running or due a retry will still read. Null when
 * pg-boss's tables cannot be read, so nothing is ever deleted from under a job on a guess.
 */
export async function liveImportKeys(): Promise<Set<string> | null> {
  try {
    const rows = await db.$queryRaw<{ key: string | null }[]>`
      SELECT data->>'importKey' AS key FROM pgboss.job
      WHERE name = ${QUEUES.importTrack} AND state IN ('created', 'retry', 'active')`;
    return new Set(rows.flatMap((r) => (r.key ? [r.key] : [])));
  } catch (err) {
    console.error("[jobs] could not read pg-boss's jobs; keeping every uploaded track file", err);
    return null;
  }
}
