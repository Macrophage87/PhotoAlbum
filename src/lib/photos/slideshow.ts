import { db } from "@/lib/db";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { photoUrl } from "@/lib/photos/urls";
import { readableTitle } from "@/lib/photos/readable-text";
import { photoDay } from "@/lib/time/local-day";
import { formatDay } from "@/lib/time/format";
import { listCollectionItems } from "@/lib/collections/queries";
import type { PhotoCard } from "@/lib/photos/queries";
import { filterIsActive, NO_FILTER, type GalleryFilter } from "@/lib/photos/filters";
import { idsInLocalYear, idsMatching, intersectIds } from "@/lib/photos/page";
import { idsWithPerson, peopleInPhotos, type FilterPerson } from "@/lib/people/in-photos";
import { timelineIds } from "@/lib/timeline/queries";
import { uploaderLabel } from "@/components/photos/toGrid";

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
  /** The same day as "2025-08-12", for whatever wants to group or pick by it; null when nobody knows the day. */
  dayKey: string | null;
  place: string | null;
};

/** What a slideshow shows: finished photographs only. A clip, a scan or a YouTube video has no still to sit on. */
const SHOWABLE = { ...NOT_TRASHED, status: "READY" as const, kind: "PHOTO" as const, width: { not: null } };

type SlideSource = Pick<PhotoCard, "id" | "imageVersion" | "width" | "height" | "title" | "membersTitle" | "caption" | "takenAt" | "tzOffsetMin" | "placeName"> & { trip: { timezone: string } | null };

export function toSlide(p: SlideSource, member: boolean): Slide {
  const dayKey = p.takenAt ? photoDay(p.takenAt, p.tzOffsetMin, p.trip?.timezone ?? "UTC") : null;
  return {
    id: p.id,
    // The medium copy: 1600 pixels fills a laptop or a television well enough, and it loads quickly on a slow line.
    src: photoUrl(p, "medium"),
    width: p.width,
    height: p.height,
    title: readableTitle(p, member),
    caption: p.caption?.trim() || null,
    day: dayKey ? formatDay(dayKey, "weekday") : null,
    dayKey,
    place: p.placeName?.trim() || null,
  };
}

/**
 * A trip's photographs in the order the trip happened, the undated last, narrowed to whatever is being looked for:
 * the same questions the trip's timeline answers, with the same answers (see `tripTimeline`). What kind of thing it
 * is goes unasked, because a slideshow is photographs whatever is asked.
 */
export async function tripSlides(tripId: string, member: boolean, filter: GalleryFilter = NO_FILTER): Promise<Slide[]> {
  const restrict = filterIsActive(filter) ? await timelineIds(filter, tripId) : null;
  if (restrict && restrict.length === 0) return [];
  const photos = await db.photo.findMany({
    where: {
      tripId,
      ...SHOWABLE,
      ...(filter.uploaderId ? { uploaderId: filter.uploaderId } : {}),
      ...(filter.activityId ? { activityId: filter.activityId } : {}),
      ...(restrict ? { id: { in: restrict } } : {}),
    },
    orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, imageVersion: true, width: true, height: true, title: true, membersTitle: true, caption: true, takenAt: true, tzOffsetMin: true, placeName: true, trip: { select: { timezone: true } } },
  });
  return photos.map((p) => toSlide(p, member));
}

/**
 * A collection's photographs in the order whoever gathered it arranged them, or by date where nobody has. Never
 * favourites first: a slideshow is often watched together, and it should tell the story the same way for everyone.
 * Narrowed the way the collection's own timeline is (see `collectionTimeline`).
 */
export async function collectionSlides(collection: { id: string; arrangedAt: Date | null }, member: boolean, filter: GalleryFilter = NO_FILTER): Promise<Slide[]> {
  const lists: string[][] = [];
  if (filter.q) lists.push(await idsMatching(filter.q, { member: filter.member, scope: { collectionId: collection.id } }));
  // A collection gathers photographs from any number of trips, so the year is asked of the whole album.
  if (filter.year) lists.push(await idsInLocalYear(null, filter.year));
  for (const id of filter.personIds) lists.push(await idsWithPerson(id));
  const keep = lists.length ? new Set(intersectIds(lists)) : null;
  if (keep && keep.size === 0) return [];
  const items = await listCollectionItems(collection.id, { order: collection.arrangedAt ? "arranged" : "oldest" });
  return items
    .filter((p) => p.status === "READY" && p.kind === "PHOTO" && p.width !== null)
    .filter((p) => (!keep || keep.has(p.id)) && (!filter.uploaderId || p.uploaderId === filter.uploaderId))
    .map((p) => toSlide(p, member));
}

/** The most a search of the whole album puts in one slideshow: an evening's worth and more, and a phone can hold it. */
export const ALBUM_SLIDES = 2000;

/**
 * A slideshow out of the whole album: every photograph that answers what is asked, wherever it is filed, oldest
 * first and the undated last. "Everything with Ada in it", or everything that says "lighthouse". Members only,
 * which is why nothing here asks what may be seen. With nothing asked there is no slideshow: the whole album in
 * one run is nobody's evening.
 */
export async function albumSlides(filter: GalleryFilter): Promise<Slide[]> {
  if (!filterIsActive(filter)) return [];
  const restrict = await timelineIds(filter, null);
  if (restrict && restrict.length === 0) return [];
  const photos = await db.photo.findMany({
    where: {
      ...SHOWABLE,
      // A trip on its way out of the album takes its photographs with it.
      OR: [{ tripId: null }, { trip: { deletingAt: null } }],
      ...(filter.uploaderId ? { uploaderId: filter.uploaderId } : {}),
      ...(restrict ? { id: { in: restrict } } : {}),
    },
    orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
    take: ALBUM_SLIDES,
    select: { id: true, imageVersion: true, width: true, height: true, title: true, membersTitle: true, caption: true, takenAt: true, tzOffsetMin: true, placeName: true, trip: { select: { timezone: true } } },
  });
  return photos.map((p) => toSlide(p, true));
}

export type SlideChoices = {
  /** How many photographs the slideshow has with nothing asked, so a narrowed one can say "12 of 340". */
  total: number;
  members: { id: string; label: string }[];
  people: FilterPerson[];
  /** A trip's outings; a collection has none of its own. */
  activities: { id: string; label: string }[];
};

/**
 * What a member may narrow a slideshow by: who uploaded something that is in it, who is on something in it, and,
 * for a trip, which outing. With no trip or collection named, it is the whole album's. The same choices the website's "More ways to narrow" offers on the timeline. Members
 * only: none of this is said to anybody else.
 */
export async function slideChoices(scope: { tripId: string } | { collectionId: string } | Record<string, never>): Promise<SlideChoices> {
  const within = "tripId" in scope ? { tripId: scope.tripId } : "collectionId" in scope ? { collections: { some: { collectionId: scope.collectionId } } } : {};
  const [total, members, people, activities] = await Promise.all([
    db.photo.count({ where: { ...within, ...SHOWABLE } }),
    db.user.findMany({ where: { photos: { some: { ...within, ...SHOWABLE } } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }),
    peopleInPhotos(scope),
    "tripId" in scope ? db.activity.findMany({ where: { tripId: scope.tripId, photos: { some: SHOWABLE } }, orderBy: { startTime: "asc" }, select: { id: true, title: true } }) : Promise.resolve([]),
  ]);
  return {
    total,
    members: members.map((m) => ({ id: m.id, label: uploaderLabel(m.name, m.email) })),
    people,
    activities: activities.map((a) => ({ id: a.id, label: a.title })),
  };
}
