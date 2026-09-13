"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { canEditMedia, NOT_YOURS } from "@/lib/auth/ownership";
import { storage } from "@/lib/storage";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { canonicalUrl, fetchDuration, fetchThumbnail, oembed, parseYouTubeUrl, YouTubeError } from "@/lib/video/youtube";
import { offsetMinutesInZone } from "@/lib/time/local-day";
import { addToCollection } from "@/app/collections/actions";

export type VideoFormState = { status: "idle" } | { status: "error"; message: string } | { status: "done"; photoId: string; title: string };

const addSchema = z.object({
  url: z.string().trim().min(1, "Paste a YouTube link"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
  tripId: z.string().optional().transform((v) => v || null),
  collectionId: z.string().optional().transform((v) => v || null),
});

/** Noon on the given calendar day in the trip's zone (UTC when there is no trip), so timelines file it on the right day. */
function instantFor(day: string, timezone: string | null): { takenAt: Date; tzOffsetMin: number } {
  const noonUtc = new Date(`${day}T12:00:00Z`);
  const tzOffsetMin = timezone ? offsetMinutesInZone(noonUtc, timezone) : 0;
  return { takenAt: new Date(noonUtc.getTime() - tzOffsetMin * 60_000), tzOffsetMin };
}

/**
 * Embed an unlisted (or public) YouTube video as a media item: fetch its title and poster through oEmbed, store
 * the poster locally so grids never call YouTube, and reuse the photo pipeline for renditions.
 */
export async function addYouTubeVideo(_prev: VideoFormState, fd: FormData): Promise<VideoFormState> {
  const user = await requireUserOrThrow();
  const parsed = addSchema.safeParse({ url: fd.get("url"), date: fd.get("date"), tripId: fd.get("tripId") ?? undefined, collectionId: fd.get("collectionId") ?? undefined });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the form" };
  const { url, date, tripId, collectionId } = parsed.data;
  const id = parseYouTubeUrl(url);
  if (!id) return { status: "error", message: "That does not look like a YouTube link." };

  const trip = tripId ? await db.trip.findUnique({ where: { id: tripId }, select: { id: true, slug: true, timezone: true } }) : null;
  if (tripId && !trip) return { status: "error", message: "That trip no longer exists." };

  let meta;
  let poster: Buffer;
  try {
    meta = await oembed(id);
    poster = await fetchThumbnail(id);
  } catch (err) {
    return { status: "error", message: err instanceof YouTubeError ? err.message : "Could not reach YouTube." };
  }
  const { takenAt, tzOffsetMin } = instantFor(date, trip?.timezone ?? null);

  const photo = await db.photo.create({
    data: {
      uploaderId: user.id,
      tripId: trip?.id ?? null,
      kind: "EXTERNAL_VIDEO",
      sourceKind: "YOUTUBE",
      provider: "YOUTUBE",
      externalId: id,
      externalUrl: canonicalUrl(id),
      title: meta.title,
      externalStatus: "AVAILABLE",
      externalCheckedAt: new Date(),
      status: "PENDING",
      originalName: `${meta.title}.jpg`,
      mimeType: "image/jpeg",
      storageKey: "pending",
      originalPath: "pending",
      sizeBytes: poster.length,
      takenAt,
      takenAtSource: "MANUAL",
      tzOffsetMin,
      exif: { youtubeAuthor: meta.authorName },
    },
  });
  const storageKey = `photos/${photo.id}`;
  const originalPath = `${storageKey}/original.jpg`;
  await storage().putBuffer(originalPath, poster);
  const durationS = await fetchDuration(id);
  await db.photo.update({ where: { id: photo.id }, data: { storageKey, originalPath, durationS } });
  await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: trip?.id ?? null, mode: "renditions" });
  if (collectionId) await addToCollection(collectionId, [photo.id]);

  revalidatePath("/", "layout");
  return { status: "done", photoId: photo.id, title: meta.title };
}

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** Retitle, change the date, or point the item at a different YouTube video (which refreshes the poster). */
export async function updateExternalVideo(photoId: string, fd: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const photo = await db.photo.findUnique({ where: { id: photoId }, include: { trip: { select: { timezone: true } } } });
  if (!photo || photo.kind !== "EXTERNAL_VIDEO") throw new Error("Not an embedded video");
  if (!canEditMedia(user, photo)) throw new Error(NOT_YOURS);
  const v = updateSchema.parse({ title: fd.get("title"), url: fd.get("url"), date: fd.get("date") });
  const id = parseYouTubeUrl(v.url);
  if (!id) throw new Error("That does not look like a YouTube link.");
  const { takenAt, tzOffsetMin } = instantFor(v.date, photo.trip?.timezone ?? null);
  const data: Parameters<typeof db.photo.update>[0]["data"] = { title: v.title, takenAt, tzOffsetMin, takenAtSource: "MANUAL" };
  if (id !== photo.externalId) {
    const meta = await oembed(id);
    const poster = await fetchThumbnail(id);
    await storage().putBuffer(photo.originalPath, poster);
    Object.assign(data, { externalId: id, externalUrl: canonicalUrl(id), externalStatus: "AVAILABLE", externalCheckedAt: new Date(), durationS: await fetchDuration(id), status: "PENDING", exif: { youtubeAuthor: meta.authorName } });
    await db.photo.update({ where: { id: photoId }, data });
    await enqueue(QUEUES.processPhoto, { photoId, tripId: photo.tripId, mode: "renditions" });
  } else {
    await db.photo.update({ where: { id: photoId }, data });
  }
  revalidatePath(`/photos/${photoId}`);
  revalidatePath("/", "layout");
}
