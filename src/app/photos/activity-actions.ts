"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { canEditMedia, editableMediaIds, NOT_YOURS } from "@/lib/auth/ownership";
import { applyPhotoInstant } from "@/lib/photos/apply-date";
import { planDate } from "@/lib/photos/bulk-date";
import { offsetMinutesInZone } from "@/lib/time/local-day";

export type MoveResult = { ok: true; where: string } | { ok: false; message: string };

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function mine(photoId: string) {
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({
    where: { id: photoId },
    select: { id: true, uploaderId: true, tripId: true, gpsSource: true, takenAt: true, tzOffsetMin: true, activityId: true, activitySetById: true, trip: { select: { timezone: true } } },
  });
  if (!photo) return { user: null, photo: null };
  return { user: canEditMedia(user, photo) ? user : null, photo };
}

/**
 * Put one item on an activity, or take it off, as a person's choice rather than an inference.
 *
 * Two people on the same afternoon do two different things, and a clock cannot tell which photograph belongs to
 * which: the walk and the boat overlap, so the album's guess from the time is only ever a starting point. Once
 * somebody says where a photograph belongs, that is where it belongs — the activity's hours no longer move it, and
 * neither does a corrected date.
 */
export async function putInActivity(photoId: string, activityId: string | null): Promise<MoveResult> {
  const { user, photo } = await mine(photoId);
  if (!photo) return { ok: false, message: "Photo not found" };
  if (!user) return { ok: false, message: NOT_YOURS };
  if (!activityId) {
    await db.photo.update({ where: { id: photo.id }, data: { activityId: null, activitySetById: null } });
    revalidatePath("/trips", "layout");
    revalidatePath("/timeline");
    return { ok: true, where: "no activity" };
  }
  const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true, title: true, tripId: true } });
  if (!activity) return { ok: false, message: "That activity no longer exists" };
  await db.photo.update({
    where: { id: photo.id },
    // An activity belongs to one trip, so filing an item there moves it onto that trip as well.
    data: { activityId: activity.id, activitySetById: user.id, tripId: activity.tripId },
  });
  revalidatePath("/trips", "layout");
  revalidatePath("/timeline");
  return { ok: true, where: activity.title };
}

/**
 * Move one item to a day, keeping its time of day — the fix for a photograph that landed under the wrong heading on
 * the timeline, which is where a wrong date shows itself.
 */
export async function moveToDay(photoId: string, day: string): Promise<MoveResult> {
  const { user, photo } = await mine(photoId);
  if (!photo) return { ok: false, message: "Photo not found" };
  if (!user) return { ok: false, message: NOT_YOURS };
  const parsed = daySchema.safeParse(day);
  if (!parsed.success) return { ok: false, message: "That is not a day" };
  const fallbackOffsetMin = photo.trip ? offsetMinutesInZone(photo.takenAt ?? new Date(), photo.trip.timezone) : 0;
  const next = planDate(photo, { mode: "day", day: parsed.data, keepTime: true }, { index: 0, fallbackOffsetMin });
  if (!next) return { ok: false, message: "That date is out of range" };
  await applyPhotoInstant(photo, next.takenAt, next.tzOffsetMin, "MANUAL", user.id);
  revalidatePath("/trips", "layout");
  revalidatePath("/timeline");
  return { ok: true, where: parsed.data };
}

/** Put a whole selection on one activity, for a batch that all belongs to the same walk. */
export async function bulkPutInActivity(photoIds: string[], activityId: string): Promise<{ n: number; notYours: number }> {
  const user = await requireUserOrThrow();
  const asked = z.array(z.string().min(1)).min(1).max(500).parse(photoIds);
  const list = await editableMediaIds(user, asked);
  const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true, tripId: true } });
  if (!activity || !list.length) return { n: 0, notYours: asked.length - list.length };
  const r = await db.photo.updateMany({ where: { id: { in: list } }, data: { activityId: activity.id, activitySetById: user.id, tripId: activity.tripId } });
  revalidatePath("/trips", "layout");
  revalidatePath("/timeline");
  return { n: r.count, notYours: asked.length - list.length };
}

/** The one trip a selection is on, when it is on one: what the activity picker needs to offer the right activities. */
export async function tripOfSelection(photoIds: string[]): Promise<{ id: string; title: string } | null> {
  await requireUserOrThrow();
  const list = z.array(z.string().min(1)).min(1).max(500).parse(photoIds);
  const trips = await db.photo.findMany({ where: { id: { in: list } }, select: { tripId: true }, distinct: ["tripId"], take: 2 });
  const only = trips.length === 1 ? trips[0].tripId : null;
  if (!only) return null;
  return db.trip.findUnique({ where: { id: only }, select: { id: true, title: true } });
}
