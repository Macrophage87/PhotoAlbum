import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
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
 * Which of these Google Photos rows a Picker download job still names while it is waiting, running or due a retry:
 * that job is still bringing the file. Unknown counts as all of them, for the same reason.
 */
export async function withLivePickerJob(photoIds: string[]): Promise<Set<string>> {
  if (!photoIds.length) return new Set();
  try {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT i.id FROM pgboss.job j CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(j.data->'photoIds', '[]'::jsonb)) AS i(id)
      WHERE j.name = ${QUEUES.googlePickerImport} AND j.state IN ('created', 'retry', 'active') AND i.id IN (${Prisma.join(photoIds)})`;
    return new Set(rows.map((r) => r.id));
  } catch (err) {
    console.error("[jobs] could not read pg-boss's jobs; treating the Google Photos downloads as still queued", err);
    return new Set(photoIds);
  }
}
