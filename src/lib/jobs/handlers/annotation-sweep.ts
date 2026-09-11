import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { annotationGates } from "@/lib/annotation/eligibility";
import { enqueue } from "../boss";
import { QUEUES } from "../queues";

/**
 * Every few minutes: enqueue items nobody has touched for the quiet period that were never annotated, or whose
 * notes changed since. Marking a batch reviewed enqueues immediately instead of waiting for this.
 */
export async function annotationSweep(): Promise<number> {
  const gates = await annotationGates();
  if (!gates.active) return 0;
  const cutoff = new Date(Date.now() - env().ANNOTATION_QUIET_MINUTES * 60_000);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Photo" p
    LEFT JOIN "Trip" t ON t.id = p."tripId"
    WHERE p.status = 'READY'
      AND p."annotationOptOut" = false
      AND COALESCE(t."annotationOptOut", false) = false
      AND NOT EXISTS (SELECT 1 FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId" WHERE ci."photoId" = p.id AND c."annotationOptOut")
      AND (p."annotatedAt" IS NULL OR (p."contextUpdatedAt" IS NOT NULL AND p."contextUpdatedAt" > p."annotatedAt"))
      AND p."updatedAt" < ${cutoff}
    LIMIT 200`;
  for (const r of rows) await enqueue(QUEUES.annotatePhoto, { photoId: r.id }, { singletonKey: `annotate:${r.id}`, singletonSeconds: 600 });
  if (rows.length) console.log(`[annotation-sweep] queued ${rows.length}`);
  return rows.length;
}

/** Enqueue specific items right away (after review), subject to the same gates and opt-outs. */
export async function enqueueAnnotation(photoIds: string[]): Promise<number> {
  const gates = await annotationGates();
  if (!gates.active || !photoIds.length) return 0;
  const rows = await db.photo.findMany({
    where: { id: { in: photoIds }, status: "READY", annotationOptOut: false, OR: [{ tripId: null }, { trip: { annotationOptOut: false } }], collections: { none: { collection: { annotationOptOut: true } } } },
    select: { id: true, annotatedAt: true, contextUpdatedAt: true },
  });
  let n = 0;
  for (const r of rows) {
    if (r.annotatedAt && !(r.contextUpdatedAt && r.contextUpdatedAt > r.annotatedAt)) continue;
    await enqueue(QUEUES.annotatePhoto, { photoId: r.id }, { singletonKey: `annotate:${r.id}`, singletonSeconds: 600 });
    n++;
  }
  return n;
}

/** Raw responses are for debugging only and are purged after the retention window. */
export async function purgeAnnotationRaw(): Promise<number> {
  const cutoff = new Date(Date.now() - env().ANNOTATION_RAW_RETENTION_DAYS * 86_400_000);
  const res = await db.mediaAnnotationRaw.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}
