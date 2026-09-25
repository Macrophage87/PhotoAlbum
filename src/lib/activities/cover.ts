import { db } from "@/lib/db";
import { NOT_TRASHED } from "@/lib/photos/trash";

/** What a cover needs to be drawn and put on a link preview: the preview is often dropped without its size. */
const select = { id: true, updatedAt: true, width: true, height: true } as const;
export type ActivityCoverPhoto = { id: string; updatedAt: Date; width: number | null; height: number | null };

/**
 * The picture an activity is known by: the one chosen by hand, while it is still one of the activity's own finished
 * photographs, and otherwise the first photograph taken on it.
 *
 * The hand-chosen one is checked rather than trusted. A photograph can be taken off an activity, moved to another,
 * or put in the trash long after it was chosen, and a shared link that unfurled with a picture from a different
 * afternoon — or one somebody has thrown away — would be worse than the album's own choice.
 */
export async function activityCover(activity: { id: string; coverPhotoId: string | null }): Promise<ActivityCoverPhoto | null> {
  const mine = { activityId: activity.id, status: "READY" as const, ...NOT_TRASHED };
  if (activity.coverPhotoId) {
    const chosen = await db.photo.findFirst({ where: { id: activity.coverPhotoId, ...mine }, select });
    if (chosen) return chosen;
  }
  return db.photo.findFirst({ where: mine, orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }], select });
}

/** The activity's photographs a cover can be chosen from, in the order they were taken. */
export async function activityCoverCandidates(activityId: string, cursor?: string | null, take = 60) {
  const where = { activityId, status: "READY" as const, ...NOT_TRASHED };
  const [rows, total] = await Promise.all([
    db.photo.findMany({
      where,
      orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, updatedAt: true, caption: true, title: true, originalName: true },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    db.photo.count({ where }),
  ]);
  const more = rows.length > take;
  const photos = more ? rows.slice(0, take) : rows;
  return { photos, nextCursor: more ? photos[photos.length - 1].id : null, total };
}
