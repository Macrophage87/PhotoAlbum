import { db } from "@/lib/db";
import { photoCardSelect } from "@/lib/photos/queries";
import { buildTimeline } from "@/lib/timeline/build";
import type { TimelineGroups } from "@/components/timeline/Timeline";
import { NOT_TRASHED } from "@/lib/photos/trash";

/** A collection's items grouped by the day each was taken (each photo carries its own offset; UTC otherwise). */
export async function collectionTimeline(collectionId: string): Promise<TimelineGroups> {
  const photos = await db.photo.findMany({ where: { ...NOT_TRASHED, status: "READY", collections: { some: { collectionId } } }, select: photoCardSelect });
  // Activities belong to trips; a collection timeline shows photos only, so no activity ever matches.
  return buildTimeline(photos.map((p) => ({ ...p, activityId: null })), [], "UTC");
}
