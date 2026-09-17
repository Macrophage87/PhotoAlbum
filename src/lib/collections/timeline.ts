import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { photoCardSelect } from "@/lib/photos/queries";
import { buildTimeline } from "@/lib/timeline/build";
import type { TimelineResult } from "@/lib/timeline/queries";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { filterIsActive, NO_FILTER, type GalleryFilter } from "@/lib/photos/filters";
import { idsMatching, idsInLocalYear, intersectIds } from "@/lib/photos/page";

/**
 * A collection's items grouped by the day each was taken (each photo carries its own offset; UTC otherwise),
 * narrowed to whatever is being looked for — the same question the trip timeline answers, asked of a gathering.
 */
export async function collectionTimeline(collectionId: string, filter: GalleryFilter = NO_FILTER): Promise<TimelineResult> {
  const active = filterIsActive(filter);
  const mine: Prisma.PhotoWhereInput = { ...NOT_TRASHED, status: "READY", collections: { some: { collectionId } } };
  const total = await db.photo.count({ where: mine });

  const lists: string[][] = [];
  if (filter.q) lists.push(await idsMatching(filter.q));
  // A collection gathers photographs from any number of trips, so the year is asked of the whole album.
  if (filter.year) lists.push(await idsInLocalYear(null, filter.year));
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
  // Activities belong to trips; a collection timeline shows photos only, so no activity ever matches.
  return { groups: buildTimeline(photos.map((p) => ({ ...p, activityId: null })), [], "UTC"), matched: photos.length, total, active };
}
