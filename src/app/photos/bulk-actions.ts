"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { trashSchema } from "@/lib/photos/trash";
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

/** Move a selection to the trash, all for the same reason. Nothing is deleted; an admin decides what happens next. */
export async function bulkTrash(photoIds: string[], reason: string, note: string): Promise<number> {
  const user = await requireUserOrThrow();
  const list = ids.parse(photoIds);
  const v = trashSchema.parse({ reason, note });
  const r = await db.photo.updateMany({ where: { id: { in: list }, trashedAt: null }, data: { trashedAt: new Date(), trashedById: user.id, trashReason: v.reason, trashNote: v.note || null } });
  revalidatePath("/", "layout");
  return r.count;
}

/** Pin every selected item to one spot (a group of prints from the same place). */
export async function bulkSetPlace(photoIds: string[], lat: number, lng: number, name?: string | null): Promise<number> {
  const user = await requireUserOrThrow();
  const list = ids.parse(photoIds);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("That is not a place on the map");
  const r = await db.photo.updateMany({ where: { id: { in: list } }, data: { lat, lng, altitude: null, gpsSource: "MANUAL", placeSetById: user.id, placeName: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null } });
  revalidatePath("/", "layout");
  return r.count;
}
