"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { editsSchema, tidyEdits } from "@/lib/images/edits";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { trashSchema } from "@/lib/photos/trash";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { pickActivityByTime, pickTripByDay } from "@/lib/photos/assign";
import { localDayFromOffset, offsetMinutesInZone, wallTimeWithOffsetToInstant } from "@/lib/time/local-day";
import { storage } from "@/lib/storage";
import { readExif, resolveTakenAt } from "@/lib/images/exif";
import type { TakenAtSource } from "@/generated/prisma/enums";
import { parseLatLng, placeNameOf } from "@/lib/geo/parse";
import { uploaderLabel } from "@/components/photos/toGrid";
import { addToCollection, removeFromCollection } from "@/app/collections/actions";

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
  // Collections come from the form's checkbox group; membership is reconciled to exactly what is ticked.
  if (fd.has("collectionsPresent")) {
    const wanted = new Set(fd.getAll("collectionIds").map(String).filter(Boolean));
    const held = new Set((await db.collectionItem.findMany({ where: { photoId: id }, select: { collectionId: true } })).map((c) => c.collectionId));
    for (const cid of wanted) if (!held.has(cid)) await addToCollection(cid, [id]);
    for (const cid of held) if (!wanted.has(cid)) await removeFromCollection(cid, [id]);
  }
  await db.photo.update({ where: { id }, data: { title, caption: v.caption, context: v.context, ...(v.context !== photo.context ? { contextUpdatedAt: new Date(), annotationError: null } : {}), tripId: v.tripId, activityId } });
  revalidatePath(`/photos/${id}`);
  if (photo.tripId) revalidatePath(`/trips`, "layout");
}

/**
 * Move an item to the trash. Any member may do this and must say why; nothing is deleted, so an admin can put it
 * back exactly as it was. The item leaves every gallery, the timeline, the map, search and every share page at once,
 * which is what makes this the right button for "take that down now".
 */
export async function trashPhoto(id: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const v = trashSchema.parse({ reason: fd.get("reason"), note: fd.get("note") ?? "" });
  const photo = await db.photo.findUnique({ where: { id }, select: { trashedAt: true, trip: { select: { slug: true } } } });
  if (!photo) return;
  if (!photo.trashedAt) {
    await db.photo.update({ where: { id }, data: { trashedAt: new Date(), trashedById: user.id, trashReason: v.reason, trashNote: v.note || null } });
  }
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
  const user = await requireUserOrThrow();
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
  await applyInstant(photo, takenAt, newOffset, "MANUAL", user.id);
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
}

export type DateResult = { ok: true; takenAt: string; tzOffsetMin: number; source: string; setBy: string | null } | { ok: false; message: string };

/**
 * Set the moment an item was taken from a wall-clock value typed by a member (interpreted in the item's current zone,
 * or the trip's, or UTC). The trip and activity are re-derived and, when the item had been placed from a track, it is
 * re-placed for the new time.
 */
export async function setPhotoDate(id: string, fd: FormData): Promise<DateResult> {
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, include: { trip: { select: { timezone: true } } } });
  if (!photo) return { ok: false, message: "Photo not found" };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(fd.get("takenAt") ?? "").trim());
  if (!m) return { ok: false, message: "Enter a date and time" };
  const wall = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0) };
  if (wall.year < 1800 || wall.year > 2100) return { ok: false, message: "That year looks wrong" };
  const tzOffsetMin = photo.tzOffsetMin ?? (photo.trip ? offsetMinutesInZone(wallTimeWithOffsetToInstant(wall, 0), photo.trip.timezone) : 0);
  const takenAt = wallTimeWithOffsetToInstant(wall, tzOffsetMin);
  await applyInstant(photo, takenAt, tzOffsetMin, "MANUAL", user.id);
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, takenAt: takenAt.toISOString(), tzOffsetMin, source: "MANUAL", setBy: uploaderLabel(user.name, user.email) };
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
  await applyInstant(photo, resolved.takenAt, resolved.tzOffsetMin, resolved.source, null);
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, takenAt: resolved.takenAt.toISOString(), tzOffsetMin: resolved.tzOffsetMin, source: resolved.source, setBy: null };
}

async function applyInstant(photo: { id: string; tripId: string | null; gpsSource: string | null }, takenAt: Date, newOffset: number, source: TakenAtSource, dateSetById: string | null): Promise<void> {
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
      dateSetById,
      tripId,
      activityId,
      ...(photo.gpsSource === "TRACK" ? { lat: null, lng: null, altitude: null, gpsSource: null } : {}),
    },
  });
  if (tripId) await enqueue(QUEUES.geotagPhotos, { tripId }, { singletonKey: `geotag:${tripId}`, singletonSeconds: 10, singletonNextSlot: true });
}

export type PlaceResult = { ok: true; lat: number | null; lng: number | null; gpsSource: string | null; setBy: string | null; placeName: string | null } | { ok: false; message: string };

/** Pin an item to a spot a member chose (a click on the map or a looked-up address). Never touched by later geotagging. */
export async function setPhotoPlace(id: string, fd: FormData): Promise<PlaceResult> {
  const user = await requireUserOrThrow();
  const pos = parseLatLng(fd.get("lat"), fd.get("lng"));
  if (!pos) return { ok: false, message: "Enter a latitude between -90 and 90 and a longitude between -180 and 180" };
  const name = placeNameOf(fd.get("name"));
  const r = await db.photo.updateMany({ where: { id }, data: { lat: pos.lat, lng: pos.lng, altitude: null, gpsSource: "MANUAL", placeSetById: user.id, placeName: name } });
  if (!r.count) return { ok: false, message: "Photo not found" };
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, lat: pos.lat, lng: pos.lng, gpsSource: "MANUAL", setBy: uploaderLabel(user.name, user.email), placeName: name };
}

/**
 * Accept the helper's guess as the item's place. The position does not move; it stops being a guess, which means a
 * track imported later no longer replaces it, and the album records who agreed to it.
 */
export async function confirmPlaceEstimate(id: string): Promise<PlaceResult> {
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, select: { lat: true, lng: true, gpsSource: true, placeName: true, placeEstimateName: true } });
  if (!photo) return { ok: false, message: "Photo not found" };
  if (photo.gpsSource !== "ESTIMATE" || photo.lat === null || photo.lng === null) return { ok: false, message: "There is no estimated place to accept" };
  // The helper's name for the place becomes the item's own, so accepting a guess does not turn it back into coordinates.
  const name = photo.placeName ?? photo.placeEstimateName;
  await db.photo.update({ where: { id }, data: { gpsSource: "MANUAL", placeSetById: user.id, placeName: name } });
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, lat: photo.lat, lng: photo.lng, gpsSource: "MANUAL", setBy: uploaderLabel(user.name, user.email), placeName: name };
}

/**
 * Forget a hand-set (or any) position; a track covering the moment may place it again. Clearing the helper's guess
 * drops what it recognised with it, but keeps the record that it was asked, so a later backfill does not put the
 * same guess back after a member has rejected it.
 */
export async function clearPhotoPlace(id: string): Promise<PlaceResult> {
  await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, select: { tripId: true } });
  if (!photo) return { ok: false, message: "Photo not found" };
  await db.photo.update({ where: { id }, data: { lat: null, lng: null, altitude: null, gpsSource: null, placeSetById: null, placeName: null, placeEstimateName: null, placeEstimateConfidence: null, placeEstimateRadiusM: null, placeEstimatePrecision: null, placeEstimateNote: null } });
  if (photo.tripId) await enqueue(QUEUES.geotagPhotos, { tripId: photo.tripId }, { singletonKey: `geotag:${photo.tripId}`, singletonSeconds: 10, singletonNextSlot: true });
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, lat: null, lng: null, gpsSource: null, setBy: null, placeName: null };
}

export type EditResult = { ok: true; edited: boolean } | { ok: false; message: string };

/**
 * Save darkroom instructions. Nothing is written over: the renditions are made again from the untouched original,
 * so reverting is simply forgetting them. Only the member who uploaded the item, or an admin, may do this — an
 * edit changes what everyone else sees, and the uploader is who the album holds responsible for the picture.
 */
export async function savePhotoEdits(id: string, raw: unknown): Promise<EditResult> {
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id }, select: { uploaderId: true, kind: true, status: true } });
  if (!photo) return { ok: false, message: "Photo not found" };
  if (photo.kind !== "PHOTO") return { ok: false, message: "Only photos can be edited here" };
  if (user.role !== "ADMIN" && photo.uploaderId !== user.id) return { ok: false, message: "Only the person who uploaded this, or an admin, can edit it" };
  const parsed = editsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Those edits do not make sense" };
  const edits = tidyEdits(parsed.data);
  await db.photo.update({
    where: { id },
    data: edits ? { edits, editedAt: new Date(), editedById: user.id } : { edits: Prisma.DbNull, editedAt: null, editedById: null },
  });
  await enqueue(QUEUES.processPhoto, { photoId: id, mode: "renditions" }, { singletonKey: `renditions:${id}`, singletonSeconds: 5, singletonNextSlot: true });
  revalidatePath(`/photos/${id}`);
  revalidatePath("/trips", "layout");
  return { ok: true, edited: Boolean(edits) };
}

/** Put the item back exactly as it was uploaded. The original never changed, so this only forgets the instructions. */
export async function revertPhotoEdits(id: string): Promise<EditResult> {
  return savePhotoEdits(id, {});
}
