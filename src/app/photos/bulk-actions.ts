"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

const ids = z.array(z.string().min(1)).min(1).max(500);

export async function bulkAssignActivity(photoIds: string[], activityId: string | null): Promise<void> {
  await requireUserOrThrow();
  const list = ids.parse(photoIds);
  if (activityId) {
    const activity = await db.activity.findUnique({ where: { id: activityId }, select: { tripId: true } });
    if (!activity) return;
    await db.photo.updateMany({ where: { id: { in: list }, tripId: activity.tripId }, data: { activityId } });
  } else {
    await db.photo.updateMany({ where: { id: { in: list } }, data: { activityId: null } });
  }
  revalidatePath("/trips", "layout");
}

export async function bulkMoveToTrip(photoIds: string[], tripId: string | null): Promise<void> {
  await requireUserOrThrow();
  const list = ids.parse(photoIds);
  if (tripId && !(await db.trip.findUnique({ where: { id: tripId }, select: { id: true } }))) return;
  await db.photo.updateMany({ where: { id: { in: list } }, data: { tripId, activityId: null } });
  if (tripId) await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true });
  revalidatePath("/", "layout");
}

export async function bulkDelete(photoIds: string[]): Promise<void> {
  await requireUserOrThrow();
  const list = ids.parse(photoIds);
  const photos = await db.photo.findMany({ where: { id: { in: list } }, select: { id: true, storageKey: true } });
  await db.photo.deleteMany({ where: { id: { in: photos.map((p) => p.id) } } });
  for (const p of photos) await enqueue(QUEUES.deletePhoto, { storageKey: p.storageKey });
  revalidatePath("/", "layout");
}
