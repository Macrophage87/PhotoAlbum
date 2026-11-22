import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { canonicalUrl, fetchDuration, fetchThumbnail, oembed, parseYouTubeUrl, YouTubeError } from "@/lib/video/youtube";
import { offsetMinutesInZone } from "@/lib/time/local-day";

export type AddedYouTube = { status: "error"; message: string } | { status: "done"; photoId: string; title: string };

/** Noon on the given calendar day in the trip's zone (UTC when there is no trip), so timelines file it on the right day. */
export function instantFor(day: string, timezone: string | null): { takenAt: Date; tzOffsetMin: number } {
  const noonUtc = new Date(`${day}T12:00:00Z`);
  const tzOffsetMin = timezone ? offsetMinutesInZone(noonUtc, timezone) : 0;
  return { takenAt: new Date(noonUtc.getTime() - tzOffsetMin * 60_000), tzOffsetMin };
}

/**
 * Adds a YouTube video to the album as a media item, for the website's form and for the phone app alike: its title
 * and poster come through oEmbed, the poster is stored here so grids never call YouTube, and the photo pipeline
 * makes its renditions. What went wrong is returned in words the member can read, never thrown.
 */
export async function addYouTube(userId: string, input: { url: string; date: string; tripId: string | null }): Promise<AddedYouTube> {
  const { url, date, tripId } = input;
  const id = parseYouTubeUrl(url);
  if (!id) return { status: "error", message: "That does not look like a YouTube link." };

  const trip = tripId ? await db.trip.findUnique({ where: { id: tripId, deletingAt: null }, select: { id: true, slug: true, timezone: true } }) : null;
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
      uploaderId: userId,
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
  try {
    await storage().putBuffer(originalPath, poster);
    const durationS = await fetchDuration(id);
    await db.photo.update({ where: { id: photo.id }, data: { storageKey, originalPath, durationS } });
  } catch (err) {
    // As the upload route does: nothing is left that would sit "processing" for ever, nor a poster with no row.
    await storage().deletePrefix(storageKey).catch(() => undefined);
    await db.photo.delete({ where: { id: photo.id } }).catch(() => undefined);
    console.error("[videos] could not store the poster", err);
    return { status: "error", message: "Could not add the video just now; try again." };
  }
  try {
    await enqueue(QUEUES.processPhoto, { photoId: photo.id, tripId: trip?.id ?? null, mode: "renditions" });
  } catch (err) {
    console.error("[videos] could not queue processing", err);
    await db.photo.update({ where: { id: photo.id }, data: { status: "FAILED", error: "Could not queue processing; use Re-process on the photo page." } }).catch(() => undefined);
  }
  return { status: "done", photoId: photo.id, title: meta.title };
}
