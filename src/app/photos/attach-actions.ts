"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { editableMediaIds } from "@/lib/auth/ownership";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { activityWindow, tripWindow } from "@/lib/photos/in-window";
import { pickActivityByTime } from "@/lib/photos/assign";

const ids = z.array(z.string().min(1)).min(1).max(500);

async function geotag(tripId: string) {
  await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true }).catch(() => undefined);
}

/**
 * Put photographs on an activity, and so on its trip, from wherever they were.
 *
 * Unlike dragging on a timeline, which only rearranges a trip's own photographs, this brings them in from anywhere:
 * the picker offers the whole album. It is a hand's decision, so it holds whatever the clocks say.
 */
export async function attachToActivity(activityId: string, photoIds: string[]): Promise<number> {
  const user = await requireUserOrThrow();
  const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true, tripId: true, trip: { select: { slug: true } } } });
  if (!activity) throw new Error("Activity not found");
  const list = await editableMediaIds(user, ids.parse(photoIds));
  if (!list.length) return 0;
  const r = await db.photo.updateMany({ where: { id: { in: list } }, data: { tripId: activity.tripId, activityId: activity.id, activitySetById: user.id } });
  await geotag(activity.tripId);
  revalidatePath(`/trips/${activity.trip.slug}`, "layout");
  return r.count;
}

/** Everything taken during the activity that is free to take: see `activityWindow` for what is left alone. */
export async function attachActivityWindow(activityId: string): Promise<{ added: number; elsewhere: number }> {
  const user = await requireUserOrThrow();
  const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true, tripId: true, startTime: true, endTime: true } });
  if (!activity) throw new Error("Activity not found");
  const { ids: found, elsewhere } = await activityWindow(user, activity);
  let added = 0;
  // In slices, as a selection is: a week-long "activity" could hold thousands.
  for (let i = 0; i < found.length; i += 500) added += await attachToActivity(activity.id, found.slice(i, i + 500));
  return { added, elsewhere };
}

/**
 * Everything taken on the trip's days that is on no trip, put on it — and each one onto the activity its time falls
 * in, as if it had arrived by upload, unless somebody already filed it by hand.
 */
export async function putTripWindow(tripId: string): Promise<{ added: number; elsewhere: number }> {
  const user = await requireUserOrThrow();
  const trip = await db.trip.findUnique({ where: { id: tripId }, select: { id: true, slug: true, startDate: true, endDate: true, timezone: true } });
  if (!trip) throw new Error("Trip not found");
  const { ids: found, elsewhere } = await tripWindow(user, trip);
  if (!found.length) return { added: 0, elsewhere };
  await db.photo.updateMany({ where: { id: { in: found } }, data: { tripId: trip.id, activityId: null, activitySetById: null } });
  const [activities, moved] = await Promise.all([
    db.activity.findMany({ where: { tripId: trip.id }, select: { id: true, startTime: true, endTime: true, participants: { select: { id: true } } } }),
    db.photo.findMany({ where: { id: { in: found } }, select: { id: true, takenAt: true, uploaderId: true } }),
  ]);
  const byActivity = new Map<string, string[]>();
  for (const p of moved) {
    // The outing is the album's guess, so it is held to who was on it, as an upload's is.
    const open = activities.filter((a) => a.participants.length === 0 || a.participants.some((x) => x.id === p.uploaderId));
    const a = p.takenAt ? pickActivityByTime(open, p.takenAt) : null;
    if (a) byActivity.set(a.id, [...(byActivity.get(a.id) ?? []), p.id]);
  }
  for (const [activityId, list] of byActivity) await db.photo.updateMany({ where: { id: { in: list } }, data: { activityId } });
  await geotag(trip.id);
  revalidatePath(`/trips/${trip.slug}`, "layout");
  return { added: found.length, elsewhere };
}
