import { db } from "@/lib/db";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { photoUrl } from "@/lib/photos/urls";
import { readableTitle } from "@/lib/photos/readable-text";
import { photoDay } from "@/lib/time/local-day";
import { formatDay } from "@/lib/time/format";
import { listCollectionItems } from "@/lib/collections/queries";
import type { PhotoCard } from "@/lib/photos/queries";

/** One picture of a slideshow, with only the words this viewer may read. */
export type Slide = {
  id: string;
  src: string;
  width: number | null;
  height: number | null;
  title: string | null;
  caption: string | null;
  /** "Tuesday, August 12, 2025", on the clock where it was taken. */
  day: string | null;
  place: string | null;
};

/** What a slideshow shows: finished photographs only. A clip, a scan or a YouTube video has no still to sit on. */
const SHOWABLE = { ...NOT_TRASHED, status: "READY" as const, kind: "PHOTO" as const, width: { not: null } };

type SlideSource = Pick<PhotoCard, "id" | "imageVersion" | "width" | "height" | "title" | "membersTitle" | "caption" | "takenAt" | "tzOffsetMin" | "placeName"> & { trip: { timezone: string } | null };

export function toSlide(p: SlideSource, member: boolean): Slide {
  return {
    id: p.id,
    // The medium copy: 1600 pixels fills a laptop or a television well enough, and it loads quickly on a slow line.
    src: photoUrl(p, "medium"),
    width: p.width,
    height: p.height,
    title: readableTitle(p, member),
    caption: p.caption?.trim() || null,
    day: p.takenAt ? formatDay(photoDay(p.takenAt, p.tzOffsetMin, p.trip?.timezone ?? "UTC"), "weekday") : null,
    place: p.placeName?.trim() || null,
  };
}

/** A trip's photographs in the order the trip happened, the undated last. */
export async function tripSlides(tripId: string, member: boolean): Promise<Slide[]> {
  const photos = await db.photo.findMany({
    where: { tripId, ...SHOWABLE },
    orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, imageVersion: true, width: true, height: true, title: true, membersTitle: true, caption: true, takenAt: true, tzOffsetMin: true, placeName: true, trip: { select: { timezone: true } } },
  });
  return photos.map((p) => toSlide(p, member));
}

/**
 * A collection's photographs in the order whoever gathered it arranged them, or by date where nobody has. Never
 * favourites first: a slideshow is often watched together, and it should tell the story the same way for everyone.
 */
export async function collectionSlides(collection: { id: string; arrangedAt: Date | null }, member: boolean): Promise<Slide[]> {
  const items = await listCollectionItems(collection.id, { order: collection.arrangedAt ? "arranged" : "oldest" });
  return items.filter((p) => p.status === "READY" && p.kind === "PHOTO" && p.width !== null).map((p) => toSlide(p, member));
}
