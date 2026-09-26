import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { enqueueEmbedding } from "@/lib/jobs/handlers/embed-photo";
import { mentionsName, scrubAnnotation, scrubName } from "./scrub";

/**
 * Take a forgotten person's name out of what the album wrote about the photographs they were on, and out of the
 * trips, collections and activities those photographs belong to.
 *
 * The helper was told the name and used it everywhere it was asked to: the record's title, caption, description and
 * search summary, and the title it copied onto the item. Its date and place evidence can mention them as well, and
 * a trip's, collection's or activity's description was written from the names of the people on its photographs.
 * All of that is rewritten here. A member's own caption and notes are theirs, and are left as they wrote them.
 *
 * The keyword index is rebuilt by the item's own trigger on the write; the semantic one is emptied at once and
 * queued to be recomputed from the scrubbed text, so neither carries the name meanwhile. The helper's raw answers,
 * kept briefly for debugging, go too: they are the name as it was first written.
 */
export async function forgetNameInText(photoIds: string[], name: string): Promise<void> {
  if (!photoIds.length || !name.trim()) return;
  const photos = await db.photo.findMany({
    where: { id: { in: photoIds } },
    select: { id: true, title: true, annotation: true, placeEstimateName: true, placeEstimateNote: true, estimatedDateNote: true, tripId: true, activityId: true, collections: { select: { collectionId: true } } },
  });
  for (const p of photos) {
    const a = p.annotation as StoredAnnotation | null;
    await db.photo.update({
      where: { id: p.id },
      data: {
        ...(a ? { annotation: scrubAnnotation(a, name) } : {}),
        // The title is usually the helper's own, copied from its record when the item had none; it is also the
        // heaviest word in the search index, which is exactly where a forgotten name must not stay.
        title: scrubName(p.title, name),
        placeEstimateName: scrubName(p.placeEstimateName, name),
        placeEstimateNote: scrubName(p.placeEstimateNote, name),
        estimatedDateNote: scrubName(p.estimatedDateNote, name),
      },
    });
  }
  const ids = photos.map((p) => p.id);
  if (!ids.length) return;
  await db.$executeRaw`UPDATE "Photo" SET "textEmbedding" = NULL WHERE id IN (${Prisma.join(ids)})`;
  await db.mediaAnnotationRaw.deleteMany({ where: { photoId: { in: ids } } });

  const tripIds = [...new Set(photos.map((p) => p.tripId).filter((v): v is string => Boolean(v)))];
  const activityIds = [...new Set(photos.map((p) => p.activityId).filter((v): v is string => Boolean(v)))];
  const collectionIds = [...new Set(photos.flatMap((p) => p.collections.map((c) => c.collectionId)))];
  const [trips, activities, collections] = await Promise.all([
    db.trip.findMany({ where: { id: { in: tripIds }, description: { not: null } }, select: { id: true, description: true } }),
    db.activity.findMany({ where: { id: { in: activityIds }, description: { not: null } }, select: { id: true, description: true } }),
    db.collection.findMany({ where: { id: { in: collectionIds }, description: { not: null } }, select: { id: true, description: true } }),
  ]);
  // Only descriptions that name them are written back, so nothing else about a trip looks changed.
  for (const t of trips) if (mentionsName(t.description, name)) await db.trip.update({ where: { id: t.id }, data: { description: scrubName(t.description, name) } });
  for (const x of activities) if (mentionsName(x.description, name)) await db.activity.update({ where: { id: x.id }, data: { description: scrubName(x.description, name) } });
  for (const c of collections) if (mentionsName(c.description, name)) await db.collection.update({ where: { id: c.id }, data: { description: scrubName(c.description, name) } });

  for (const id of ids) await enqueueEmbedding(id, true);
}
