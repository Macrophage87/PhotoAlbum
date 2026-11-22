import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { enqueueAnnotation } from "@/lib/jobs/handlers/annotation-sweep";

type Run = { status: "RUNNING" | "ENDED" | "FAILED"; startedById: string; ownerId: string | null; startedAt: Date; endedAt: Date | null };

/**
 * The photos one Takeout run brought in and nobody has reviewed yet. Only one import runs at a time and nothing else
 * makes Takeout rows, so they are the owner's Takeout rows made while the run was going. Photos it only repaired were
 * in the album already, and are left to whoever has them.
 */
export function unreviewedFromRun(run: Run): Prisma.PhotoWhereInput {
  return { sourceKind: "TAKEOUT", uploaderId: run.ownerId ?? run.startedById, reviewedAt: null, ...NOT_TRASHED, createdAt: { gte: run.startedAt, ...(run.endedAt ? { lte: run.endedAt } : {}) } };
}

const CHUNK = 500;

/**
 * Mark everything a finished run brought in as reviewed, in one step (#12): a whole library would otherwise sit in
 * the Unreviewed queue. Reviewing sends the items to the AI helper when it is on, as marking them on the review
 * screen does. Answers how many were marked.
 */
export async function markRunReviewed(importId: string): Promise<number> {
  const run = await db.takeoutImport.findUnique({ where: { id: importId } });
  if (!run || run.status === "RUNNING") return 0;
  const where = unreviewedFromRun(run);
  let n = 0;
  for (;;) {
    const ids = (await db.photo.findMany({ where, select: { id: true }, take: CHUNK, orderBy: { id: "asc" } })).map((p) => p.id);
    if (!ids.length) break;
    const res = await db.photo.updateMany({ where: { id: { in: ids }, reviewedAt: null }, data: { reviewedAt: new Date() } });
    n += res.count;
    await enqueueAnnotation(ids);
    if (ids.length < CHUNK) break;
  }
  return n;
}
