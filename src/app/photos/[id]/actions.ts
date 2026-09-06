"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { pickActivityByTime, pickTripByDay } from "@/lib/photos/assign";
import { localDayFromOffset, offsetMinutesInZone } from "@/lib/time/local-day";

const updateSchema = z.object({
  caption: z.string().trim().max(1000).transform((v) => v || null),
  tripId: z.string().transform((v) => v || null),
  activityId: z.string().optional().transform((v) => v || null),
});

export async function updatePhoto(id: string, fd: FormData): Promise<void> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id } });
  if (!photo) throw new Error("Photo not found");
  const v = updateSchema.parse({ caption: fd.get("caption") ?? "", tripId: fd.get("tripId") ?? "", activityId: fd.get("activityId") ?? undefined });

  if (v.tripId && !(await db.trip.findUnique({ where: { id: v.tripId }, select: { id: true } }))) throw new Error("That trip no longer exists");

  let activityId = v.activityId;
  if (v.tripId !== photo.tripId) {
    // Trip changed: re-derive the activity from the new trip's windows.
    activityId = null;
    if (v.tripId && photo.takenAt) {
      const acts = await db.activity.findMany({ where: { tripId: v.tripId }, select: { id: true, startTime: true, endTime: true } });
      activityId = pickActivityByTime(acts, photo.takenAt)?.id ?? null;
    }
  } else if (activityId) {
    const act = await db.activity.findFirst({ where: { id: activityId, tripId: v.tripId ?? "" }, select: { id: true } });
    if (!act) activityId = null;
  }
  await db.photo.update({ where: { id }, data: { caption: v.caption, tripId: v.tripId, activityId } });
  revalidatePath(`/photos/${id}`);
  if (photo.tripId) revalidatePath(`/trips`, "layout");
}

export async function deletePhoto(id: string): Promise<void> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, include: { trip: { select: { slug: true } } } });
  if (!photo) return;
  await db.photo.delete({ where: { id } });
  await enqueue(QUEUES.deletePhoto, { storageKey: photo.storageKey });
  revalidatePath("/", "layout");
  redirect(photo.trip ? `/trips/${photo.trip.slug}/photos` : "/upload");
}

export async function reprocessPhoto(id: string): Promise<void> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, select: { id: true, tripId: true } });
  if (!photo) return;
  await db.photo.update({ where: { id }, data: { status: "PENDING", error: null } });
  await enqueue(QUEUES.processPhoto, { photoId: id, tripId: photo.tripId });
  revalidatePath(`/photos/${id}`);
}

export async function setAsCover(id: string): Promise<void> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, select: { tripId: true, trip: { select: { slug: true } } } });
  if (!photo?.tripId) return;
  await db.trip.update({ where: { id: photo.tripId }, data: { coverPhotoId: id } });
  revalidatePath(`/trips/${photo.trip!.slug}`, "layout");
  revalidatePath("/");
  revalidatePath(`/photos/${id}`);
}

/**
 * Re-interpret the photo's wall-clock time in a different zone. The time shown on the camera stays
 * the same; the UTC instant moves. Then trip/activity assignment and track geotagging are redone.
 */
export async function shiftPhotoTimezone(id: string, fd: FormData): Promise<void> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, include: { trip: { select: { timezone: true } } } });
  if (!photo?.takenAt) return;
  const raw = String(fd.get("offset") ?? "");
  let newOffset: number;
  if (raw === "trip") {
    if (!photo.trip) return;
    newOffset = offsetMinutesInZone(photo.takenAt, photo.trip.timezone);
  } else {
    newOffset = Number(raw);
    if (!Number.isFinite(newOffset) || Math.abs(newOffset) > 14 * 60) return;
  }
  const oldOffset = photo.tzOffsetMin ?? 0;
  const takenAt = new Date(photo.takenAt.getTime() + (oldOffset - newOffset) * 60_000);

  let tripId = photo.tripId;
  if (!tripId) {
    const trips = await db.trip.findMany({ select: { id: true, startDate: true, endDate: true } });
    tripId = pickTripByDay(trips, localDayFromOffset(takenAt, newOffset))?.id ?? null;
  }
  let activityId: string | null = null;
  if (tripId) {
    const acts = await db.activity.findMany({ where: { tripId }, select: { id: true, startTime: true, endTime: true } });
    activityId = pickActivityByTime(acts, takenAt)?.id ?? null;
  }
  await db.photo.update({
    where: { id },
    data: {
      takenAt,
      tzOffsetMin: newOffset,
      takenAtSource: "MANUAL",
      tripId,
      activityId,
      ...(photo.gpsSource === "TRACK" ? { lat: null, lng: null, altitude: null, gpsSource: null } : {}),
    },
  });
  if (tripId) await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true });
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
}
