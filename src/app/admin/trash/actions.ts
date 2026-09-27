"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { requireAdminOrThrow } from "@/lib/auth/viewer";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

const ids = z.array(z.string().min(1)).min(1).max(500);

/** Put items back exactly as they were: the trash keeps the record and the file, so nothing has to be rebuilt. */
export async function restoreFromTrash(photoIds: string[]): Promise<number> {
  await requireAdminOrThrow();
  const list = ids.parse(photoIds);
  const trips = await db.photo.findMany({ where: { id: { in: list }, trashedAt: { not: null }, tripId: { not: null } }, select: { tripId: true }, distinct: ["tripId"] });
  const r = await db.photo.updateMany({ where: { id: { in: list }, trashedAt: { not: null } }, data: { trashedAt: null, trashedById: null, trashReason: null, trashNote: null } });
  // A track deleted while they were in the trash took back the positions it gave them; place them from what is left.
  for (const { tripId } of trips) {
    await enqueue(QUEUES.geotagPhotos, { tripId: tripId! }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true }).catch((err) => {
      console.error(`[trash] could not queue geotagging for trip ${tripId} after a restore`, err);
    });
  }
  revalidatePath("/", "layout");
  return r.count;
}

/**
 * Delete for good: the row goes, and a job removes the file and every rendition from disk. Only an admin can do
 * this, and only to something already in the trash, so one wrong click can never lose a photo.
 */
export async function deleteFromTrash(photoIds: string[]): Promise<number> {
  await requireAdminOrThrow();
  const list = ids.parse(photoIds);
  // Still in the trash when it is deleted, in the one statement: one restored meanwhile stays, and so do its files.
  const photos = await db.$queryRaw<{ id: string; storageKey: string }[]>`
    DELETE FROM "Photo" WHERE id IN (${Prisma.join(list)}) AND "trashedAt" IS NOT NULL RETURNING id, "storageKey"`;
  if (!photos.length) return 0;
  // A Picker item whose download failed has only the "pending" placeholder for a key: its own folder is what goes.
  for (const p of photos) await enqueue(QUEUES.deletePhoto, { storageKey: p.storageKey === "pending" ? `photos/${p.id}` : p.storageKey });
  revalidatePath("/", "layout");
  return photos.length;
}
