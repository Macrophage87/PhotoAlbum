import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { photoCardSelect } from "@/lib/photos/queries";
import { buildTimeline } from "@/lib/timeline/build";
import type { TimelineResult } from "@/lib/timeline/queries";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { filterIsActive, NO_FILTER, type GalleryFilter } from "@/lib/photos/filters";
import { idsMatching, idsInLocalYear, intersectIds } from "@/lib/photos/page";
import { idsWithPerson } from "@/lib/people/in-photos";
import { photoOffsetMin } from "@/lib/time/local-day";

/**
 * A collection's items grouped by the day each was taken (on its own offset, else its trip's zone, else UTC),
 * narrowed to whatever is being looked for — the same question the trip timeline answers, asked of a gathering.
 */
export async function collectionTimeline(collectionId: string, filter: GalleryFilter = NO_FILTER): Promise<TimelineResult> {
  const active = filterIsActive(filter);
  const mine: Prisma.PhotoWhereInput = { ...NOT_TRASHED, status: "READY", collections: { some: { collectionId } } };
  const total = await db.photo.count({ where: mine });

  const lists: string[][] = [];
  if (filter.q) lists.push(await idsMatching(filter.q, { member: filter.member, scope: { collectionId } }));
  // A collection gathers photographs from any number of trips, so the year is asked of the whole album.
  if (filter.year) lists.push(await idsInLocalYear(null, filter.year));
  // One list per name, so two names means the photographs they are both on rather than either.
  for (const id of filter.personIds) lists.push(await idsWithPerson(id));
  const restrict = lists.length ? intersectIds(lists) : null;
  if (restrict && restrict.length === 0) return { groups: [], matched: 0, total, active };

  const photos = await db.photo.findMany({
    where: {
      ...mine,
      ...(filter.uploaderId ? { uploaderId: filter.uploaderId } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(restrict ? { id: { in: restrict } } : {}),
    },
    select: photoCardSelect,
  });
  // Activities belong to trips; a collection timeline shows photos only, so no activity ever matches. Its photos
  // come from any number of trips, so each is given the offset its own trip's zone reads it on (see
  // `photoOffsetMin`) and the timeline's zone is never needed: its days and its times of day are each photo's own.
  const onOwnClock = photos.map((p) => ({ ...p, activityId: null, tzOffsetMin: p.takenAt ? photoOffsetMin(p.takenAt, p.tzOffsetMin, p.trip?.timezone) : p.tzOffsetMin }));
  return { groups: buildTimeline(onOwnClock, [], "UTC"), matched: photos.length, total, active };
}
