import { db } from "@/lib/db";
import { photoCardSelect } from "@/lib/photos/queries";
import { buildTimeline } from "./build";
import type { TimelineGroups } from "@/components/timeline/Timeline";

/** Photos per timeline page; the page ends at a day boundary so no day is split. */
export const TIMELINE_PAGE = 400;

export type TimelinePage = { groups: TimelineGroups; /** Pass as `after` for the following page, or null when this was the last. */ nextAfter: Date | null; paged: boolean };

/**
 * One page of a trip's timeline: photos in capture order from `after` (exclusive), cut at the last complete day,
 * with the activities of the days shown. Undated photos come on the final page.
 */
export async function tripTimeline(tripId: string, timezone: string, opts: { after?: Date | null; limit?: number } = {}): Promise<TimelinePage> {
  const limit = opts.limit ?? TIMELINE_PAGE;
  const after = opts.after ?? null;
  const [batch, activities] = await Promise.all([
    db.photo.findMany({
      where: { tripId, status: "READY", ...(after ? { takenAt: { gt: after } } : {}) },
      orderBy: [{ takenAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      select: photoCardSelect,
      take: limit + 1,
    }),
    db.activity.findMany({ where: { tripId }, orderBy: { startTime: "asc" }, include: { track: { select: { simplified: true, stats: true } } } }),
  ]);
  const more = batch.length > limit;
  let photos = more ? batch.slice(0, limit) : batch;
  let nextAfter: Date | null = null;
  if (more) {
    // Drop the trailing partial day so it opens the next page whole (unless the page is a single day).
    const lastDay = photos[photos.length - 1].takenAt?.toISOString().slice(0, 10);
    const firstDay = photos[0].takenAt?.toISOString().slice(0, 10);
    if (lastDay && firstDay !== lastDay) photos = photos.filter((p) => p.takenAt && p.takenAt.toISOString().slice(0, 10) !== lastDay);
    nextAfter = photos[photos.length - 1].takenAt ?? null;
  }
  const dated = photos.filter((p) => p.takenAt);
  const from = after ?? dated[0]?.takenAt ?? null;
  const to = more ? nextAfter : null;
  // On a paged view only the activities inside the window are shown, so they do not repeat on every page.
  const shownActivities = after || more ? activities.filter((a) => (!from || a.endTime > from) && (!to || a.startTime <= to)) : activities;
  return { groups: buildTimeline(photos, shownActivities, timezone), nextAfter, paged: Boolean(after || more) };
}
