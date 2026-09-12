import { readFile } from "node:fs/promises";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import type { Renditions } from "@/lib/images/renditions";
import { embedImage, embedText, mlConfigured, vectorLiteral } from "@/lib/ml/client";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { upsertNeighbours } from "@/lib/graph/neighbours";
import { withHeavyLock } from "../heavy-lock";
import { enqueue } from "../boss";
import { QUEUES, type EmbedPhotoJob } from "../queues";

/** Text the semantic index is built from: the helper's summary and caption, plus the family's own words. */
export function textForEmbedding(p: { caption: string | null; context: string | null; title: string | null; annotation: unknown }): string {
  const a = p.annotation as StoredAnnotation | null;
  return [p.title, p.caption, a?.caption, a?.searchSummary, a?.description, p.context].filter(Boolean).join(". ").slice(0, 2000);
}

/** Image embedding from the medium rendition and a text embedding from the description. Under the heavy lock. */
export async function embedPhoto(job: EmbedPhotoJob): Promise<void> {
  if (!mlConfigured()) return;
  const photo = await db.photo.findUnique({ where: { id: job.photoId }, select: { id: true, status: true, renditions: true, caption: true, context: true, title: true, annotation: true } });
  if (!photo || photo.status !== "READY") return;
  const medium = (photo.renditions as Renditions | null)?.medium;
  const local = medium ? storage().localPath?.(medium.key) : undefined;
  await withHeavyLock(async () => {
    const image = local && !job.textOnly ? await embedImage(await readFile(local)) : null;
    const text = textForEmbedding(photo);
    const [textVec] = text ? await embedText([text]) : [null];
    const sets: Prisma.Sql[] = [Prisma.sql`"embeddedAt" = now()`];
    if (image) sets.push(Prisma.sql`"embedding" = ${vectorLiteral(image)}::vector`);
    if (textVec) sets.push(Prisma.sql`"textEmbedding" = ${vectorLiteral(textVec)}::vector`);
    await db.$executeRaw`UPDATE "Photo" SET ${Prisma.join(sets, ", ")} WHERE id = ${photo.id}`;
    if (image) await upsertNeighbours(photo.id);
  });
}

/** Queue an embedding for one item (idempotent within a minute). */
export async function enqueueEmbedding(photoId: string, textOnly = false): Promise<void> {
  if (!mlConfigured()) return;
  await enqueue(QUEUES.embedPhoto, { photoId, textOnly }, { singletonKey: `embed:${photoId}:${textOnly ? "t" : "i"}`, singletonSeconds: 60 });
}

/** Catch-up sweep: ready items with no embedding yet, or described since they were last embedded. */
export async function embedSweep(): Promise<number> {
  if (!mlConfigured()) return 0;
  const rows = await db.$queryRaw<{ id: string; textOnly: boolean }[]>`
    SELECT id, ("embedding" IS NOT NULL) AS "textOnly" FROM "Photo"
    WHERE status = 'READY' AND renditions IS NOT NULL AND "trashedAt" IS NULL
      AND ("embedding" IS NULL OR ("annotatedAt" IS NOT NULL AND ("embeddedAt" IS NULL OR "annotatedAt" > "embeddedAt")))
    ORDER BY "createdAt" DESC LIMIT 100`;
  for (const r of rows) await enqueueEmbedding(r.id, r.textOnly);
  return rows.length;
}
