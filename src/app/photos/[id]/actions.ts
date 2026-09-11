"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { pickActivityByTime, pickTripByDay } from "@/lib/photos/assign";
import { localDayFromOffset, offsetMinutesInZone, wallTimeWithOffsetToInstant } from "@/lib/time/local-day";
import { storage } from "@/lib/storage";
import { readExif, resolveTakenAt } from "@/lib/images/exif";
import type { TakenAtSource } from "@/generated/prisma/enums";

const updateSchema = z.object({
  title: z.string().trim().max(120).optional().transform((v) => v || null),
  caption: z.string().trim().max(1000).transform((v) => v || null),
  context: z.string().trim().max(4000).transform((v) => v || null),
  tripId: z.string().transform((v) => v || null),
  activityId: z.string().optional().transform((v) => v || null),
});

export async function updatePhoto(id: string, fd: FormData): Promise<void> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id } });
  if (!photo) throw new Error("Photo not found");
  const v = updateSchema.parse({ title: fd.get("title") ?? undefined, caption: fd.get("caption") ?? "", context: fd.get("context") ?? "", tripId: fd.get("tripId") ?? "", activityId: fd.get("activityId") ?? undefined });

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
  // The title field is on the photo form only; an embedded video's title is edited with its link, so it is left alone here.
  const title = fd.has("title") && photo.kind !== "EXTERNAL_VIDEO" ? v.title : photo.title;
  await db.photo.update({ where: { id }, data: { title, caption: v.caption, context: v.context, ...(v.context !== photo.context ? { contextUpdatedAt: new Date(), annotationError: null } : {}), tripId: v.tripId, activityId } });
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
  await applyInstant(photo, takenAt, newOffset, "MANUAL");
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
}

export type DateResult = { ok: true; takenAt: string; tzOffsetMin: number; source: string } | { ok: false; message: string };

/**
 * Set the moment an item was taken from a wall-clock value typed by a member (interpreted in the item's current zone,
 * or the trip's, or UTC). The trip and activity are re-derived and, when the item had been placed from a track, it is
 * re-placed for the new time.
 */
export async function setPhotoDate(id: string, fd: FormData): Promise<DateResult> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, include: { trip: { select: { timezone: true } } } });
  if (!photo) return { ok: false, message: "Photo not found" };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(fd.get("takenAt") ?? "").trim());
  if (!m) return { ok: false, message: "Enter a date and time" };
  const wall = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0) };
  if (wall.year < 1800 || wall.year > 2100) return { ok: false, message: "That year looks wrong" };
  const tzOffsetMin = photo.tzOffsetMin ?? (photo.trip ? offsetMinutesInZone(wallTimeWithOffsetToInstant(wall, 0), photo.trip.timezone) : 0);
  const takenAt = wallTimeWithOffsetToInstant(wall, tzOffsetMin);
  await applyInstant(photo, takenAt, tzOffsetMin, "MANUAL");
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, takenAt: takenAt.toISOString(), tzOffsetMin, source: "MANUAL" };
}

/** Go back to what the camera wrote in the file: the EXIF date, resolved the same way processing does. */
export async function resetPhotoDateToCamera(id: string): Promise<DateResult> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, include: { trip: { select: { timezone: true } } } });
  if (!photo) return { ok: false, message: "Photo not found" };
  const local = storage().localPath?.(photo.originalPath);
  if (!local || photo.kind !== "PHOTO") return { ok: false, message: "No camera date is available for this item" };
  const exif = await readExif(local).catch(() => null);
  const resolved = exif ? resolveTakenAt(exif, photo.trip?.timezone ?? null) : null;
  if (!resolved) return { ok: false, message: "This file carries no camera date" };
  await applyInstant(photo, resolved.takenAt, resolved.tzOffsetMin, resolved.source);
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, takenAt: resolved.takenAt.toISOString(), tzOffsetMin: resolved.tzOffsetMin, source: resolved.source };
}

async function applyInstant(photo: { id: string; tripId: string | null; gpsSource: string | null }, takenAt: Date, newOffset: number, source: TakenAtSource): Promise<void> {
  const id = photo.id;
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
      takenAtSource: source,
      tripId,
      activityId,
      ...(photo.gpsSource === "TRACK" ? { lat: null, lng: null, altitude: null, gpsSource: null } : {}),
    },
  });
  if (tripId) await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true });
}
