"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { fieldErrors, tripInputFromForm } from "@/lib/trips/validation";
import { dayToDateColumn } from "@/lib/time/local-day";
import { generateToken } from "@/lib/auth/tokens";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import type { TripFormState } from "@/app/trips/new/actions";
import { levelOf } from "@/lib/visibility/exposure";

async function loadEditableTrip(slug: string) {
  await requireUserOrThrow();
  const trip = await db.trip.findUnique({ where: { slug } });
  if (!trip) throw new Error("Trip not found");
  return trip;
}

export async function updateTrip(slug: string, _prev: TripFormState, fd: FormData): Promise<TripFormState> {
  const trip = await loadEditableTrip(slug);
  const parsed = tripInputFromForm(fd);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  await db.trip.update({
    where: { id: trip.id },
    data: { title: v.title, description: v.description, startDate: dayToDateColumn(v.startDate), endDate: dayToDateColumn(v.endDate), timezone: v.timezone, themeKey: v.themeKey },
  });
  revalidatePath(`/trips/${slug}`, "layout");
  redirect(`/trips/${slug}/settings?saved=1`);
}

const visibilitySchema = z.enum(["PRIVATE", "LINK", "PUBLIC"]);

export async function setVisibility(slug: string, fd: FormData): Promise<void> {
  const trip = await loadEditableTrip(slug);
  const visibility = visibilitySchema.parse(fd.get("visibility"));
  const shareToken = visibility === "LINK" ? (trip.shareToken ?? generateToken()) : null;
  await db.trip.update({ where: { id: trip.id }, data: { visibility, shareToken } });
  // Bump photo versions so public caches stop matching after a change in exposure.
  await db.photo.updateMany({ where: { tripId: trip.id }, data: { updatedAt: new Date() } });
  revalidatePath(`/trips/${slug}`, "layout");
  revalidatePath("/");
}

export async function rotateShareToken(slug: string): Promise<void> {
  const trip = await loadEditableTrip(slug);
  if (trip.visibility !== "LINK") return;
  await db.trip.update({ where: { id: trip.id }, data: { shareToken: generateToken() } });
  // New token, new rendition URLs: private caches keyed on the old ?v= stop matching.
  await db.photo.updateMany({ where: { tripId: trip.id }, data: { updatedAt: new Date() } });
  revalidatePath(`/trips/${slug}/settings`);
}

export async function setCoverPhoto(slug: string, photoId: string | null): Promise<void> {
  const trip = await loadEditableTrip(slug);
  if (photoId) {
    const photo = await db.photo.findFirst({ where: { id: photoId, tripId: trip.id }, select: { id: true } });
    if (!photo) throw new Error("Photo is not on this trip");
  }
  await db.trip.update({ where: { id: trip.id }, data: { coverPhotoId: photoId } });
  revalidatePath(`/trips/${slug}`, "layout");
  revalidatePath("/");
}

export async function deleteTrip(slug: string, fd: FormData): Promise<void> {
  const trip = await loadEditableTrip(slug);
  const deletePhotos = fd.get("deletePhotos") === "on";
  if (deletePhotos) {
    const photos = await db.photo.findMany({ where: { tripId: trip.id }, select: { id: true, storageKey: true } });
    for (const p of photos) await enqueue(QUEUES.deletePhoto, { storageKey: p.storageKey });
    await db.photo.deleteMany({ where: { tripId: trip.id } });
  }
  await db.trip.delete({ where: { id: trip.id } });
  revalidatePath("/");
  redirect("/");
}

/** Clear track-derived positions and recompute them from the trip's current tracks. */
export async function regeotagPhotos(slug: string): Promise<void> {
  const trip = await loadEditableTrip(slug);
  await db.photo.updateMany({ where: { tripId: trip.id, gpsSource: "TRACK" }, data: { lat: null, lng: null, altitude: null, gpsSource: null } });
  await enqueue(QUEUES.geotagPhotos, { tripId: trip.id });
  revalidatePath(`/trips/${slug}`, "layout");
  redirect(`/trips/${slug}/settings?regeotag=1`);
}

/** Remove this trip's photos from every collection that shows them more widely than the trip does. */
export async function detachExposedFromCollections(slug: string): Promise<void> {
  const trip = await loadEditableTrip(slug);
  const level = levelOf(trip.visibility);
  const items = await db.collectionItem.findMany({ where: { photo: { tripId: trip.id } }, select: { id: true, photoId: true, collection: { select: { visibility: true, coverPhotoId: true, id: true } } } });
  const doomed = items.filter((i) => levelOf(i.collection.visibility) > level);
  if (doomed.length) {
    await db.collectionItem.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
    const covers = doomed.filter((d) => d.collection.coverPhotoId === d.photoId);
    for (const c of covers) await db.collection.update({ where: { id: c.collection.id }, data: { coverPhotoId: null } });
    await db.photo.updateMany({ where: { id: { in: doomed.map((d) => d.photoId) } }, data: { updatedAt: new Date() } });
  }
  revalidatePath(`/trips/${slug}`, "layout");
  revalidatePath("/", "layout");
  redirect(`/trips/${slug}/settings?saved=1`);
}
