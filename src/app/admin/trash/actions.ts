"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminOrThrow } from "@/lib/auth/viewer";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

const ids = z.array(z.string().min(1)).min(1).max(500);

/** Put items back exactly as they were: the trash keeps the record and the file, so nothing has to be rebuilt. */
export async function restoreFromTrash(photoIds: string[]): Promise<number> {
  await requireAdminOrThrow();
  const list = ids.parse(photoIds);
  const r = await db.photo.updateMany({ where: { id: { in: list }, trashedAt: { not: null } }, data: { trashedAt: null, trashedById: null, trashReason: null, trashNote: null } });
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
  const photos = await db.photo.findMany({ where: { id: { in: list }, trashedAt: { not: null } }, select: { id: true, storageKey: true } });
  if (!photos.length) return 0;
  await db.photo.deleteMany({ where: { id: { in: photos.map((p) => p.id) } } });
  for (const p of photos) await enqueue(QUEUES.deletePhoto, { storageKey: p.storageKey });
  revalidatePath("/", "layout");
  return photos.length;
}
