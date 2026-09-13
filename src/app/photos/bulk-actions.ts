"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { trashSchema } from "@/lib/photos/trash";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { applyPhotoInstant, requestGeotag } from "@/lib/photos/apply-date";
import { datePlanSchema, isEmptyPlan, planDate } from "@/lib/photos/bulk-date";
import { offsetMinutesInZone } from "@/lib/time/local-day";
import { editableMediaIds } from "@/lib/auth/ownership";

const ids = z.array(z.string().min(1)).min(1).max(500);

export async function bulkAssignActivity(photoIds: string[], activityId: string | null): Promise<void> {
  const user = await requireUserOrThrow();
  // A selection reaches across the family's photos; a bulk change touches only the part of it this member may change.
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return;
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
  const user = await requireUserOrThrow();
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return;
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
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("That is not a place on the map");
  const r = await db.photo.updateMany({ where: { id: { in: list } }, data: { lat, lng, altitude: null, gpsSource: "MANUAL", placeSetById: user.id, placeName: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : null } });
  revalidatePath("/", "layout");
  return r.count;
}

const dateOrder = [{ takenAt: "asc" as const }, { originalName: "asc" as const }];

type PlannedRow = { id: string; label: string; before: { at: string; tzOffsetMin: number } | null; after: { at: string; tzOffsetMin: number } };

/** Read the selection, work out what the plan does to each item, and hand back both the rows and what was skipped. */
async function planSelection(user: { id: string; role: "ADMIN" | "MEMBER" }, photoIds: string[], plan: unknown) {
  const asked = ids.parse(photoIds);
  const list = await editableMediaIds(user, asked);
  const notYours = asked.length - list.length;
  const p = datePlanSchema.parse(plan);
  const photos = await db.photo.findMany({
    where: { id: { in: list }, trashedAt: null },
    select: { id: true, tripId: true, gpsSource: true, activityId: true, activitySetById: true, takenAt: true, tzOffsetMin: true, caption: true, title: true, originalName: true, trip: { select: { timezone: true } } },
    orderBy: dateOrder,
  });
  const rows: (PlannedRow & { photo: (typeof photos)[number] })[] = [];
  let skipped = 0;
  photos.forEach((photo, index) => {
    const fallbackOffsetMin = photo.trip ? offsetMinutesInZone(photo.takenAt ?? new Date(), photo.trip.timezone) : 0;
    const next = isEmptyPlan(p) ? null : planDate(photo, p, { index, fallbackOffsetMin });
    if (!next) { skipped += 1; return; }
    rows.push({
      photo,
      id: photo.id,
      label: photo.caption ?? photo.title ?? photo.originalName,
      before: photo.takenAt ? { at: photo.takenAt.toISOString(), tzOffsetMin: photo.tzOffsetMin ?? fallbackOffsetMin } : null,
      after: { at: next.takenAt.toISOString(), tzOffsetMin: next.tzOffsetMin },
    });
  });
  return { rows, skipped, notYours };
}

/**
 * What a date correction would do, before it does it. A run of wrong dates is usually spotted on a timeline, where
 * the thing a member wants to check is that the corrected dates land where they remember being — so they read the
 * before and after of a few of them rather than the arithmetic.
 */
export async function previewBulkDate(photoIds: string[], plan: unknown): Promise<{ rows: PlannedRow[]; count: number; skipped: number; notYours: number }> {
  const user = await requireUserOrThrow();
  const { rows, skipped, notYours } = await planSelection(user, photoIds, plan);
  return { rows: rows.slice(0, 6).map((row) => ({ id: row.id, label: row.label, before: row.before, after: row.after })), count: rows.length, skipped, notYours };
}

/** Apply that correction. Items the plan cannot touch (a shift needs a date to shift) are left exactly as they were. */
export async function bulkSetDate(photoIds: string[], plan: unknown): Promise<{ n: number; skipped: number; notYours: number }> {
  const user = await requireUserOrThrow();
  const { rows, skipped, notYours } = await planSelection(user, photoIds, plan);
  const trips = new Set<string>();
  for (const row of rows) {
    const tripId = await applyPhotoInstant(row.photo, new Date(row.after.at), row.after.tzOffsetMin, "MANUAL", user.id, { geotag: false });
    if (tripId) trips.add(tripId);
  }
  // One re-geotag per trip rather than one per photo: the job walks the whole trip anyway.
  for (const tripId of trips) await requestGeotag(tripId);
  revalidatePath("/", "layout");
  return { n: rows.length, skipped, notYours };
}
