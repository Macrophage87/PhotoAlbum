import { db } from "@/lib/db";
import { photoCardSelect } from "@/lib/photos/queries";
import { buildTimeline } from "./build";
import type { TimelineGroups } from "@/components/timeline/Timeline";
import { NOT_TRASHED } from "@/lib/photos/trash";

/** Photos per timeline page; the page ends at a day boundary so no day is split. */
export const TIMELINE_PAGE = 400;

/** Where the next page starts: after this instant, or after this id within the same instant (bursts share a second). */
export type TimelineCursor = { after: Date; afterId: string };

export type TimelinePage = { groups: TimelineGroups; /** Cursor for the following page, or null when this was the last. */ next: TimelineCursor | null; paged: boolean };

export function encodeCursor(c: TimelineCursor): string {
  return `${c.after.toISOString()}~${c.afterId}`;
}

export function decodeCursor(raw: string | undefined): TimelineCursor | null {
  if (typeof raw !== "string") return null;
  const [iso, id] = raw.split("~");
  if (!iso || !id || Number.isNaN(Date.parse(iso))) return null;
  return { after: new Date(iso), afterId: id };
}

/**
 * One page of a trip's timeline: dated photos in capture order from the cursor (exclusive), cut at the last complete
 * day, with the activities of the days shown. Undated photos are appended to the final page only.
 */
export async function tripTimeline(tripId: string, timezone: string, opts: { cursor?: TimelineCursor | null; limit?: number } = {}): Promise<TimelinePage> {
  const limit = opts.limit ?? TIMELINE_PAGE;
  const cursor = opts.cursor ?? null;
  const [batch, activities] = await Promise.all([
    db.photo.findMany({
      where: { tripId, ...NOT_TRASHED, status: "READY", takenAt: { not: null }, ...(cursor ? { OR: [{ takenAt: { gt: cursor.after } }, { takenAt: cursor.after, id: { gt: cursor.afterId } }] } : {}) },
      orderBy: [{ takenAt: "asc" }, { id: "asc" }],
      select: photoCardSelect,
      take: limit + 1,
    }),
    db.activity.findMany({ where: { tripId }, orderBy: { startTime: "asc" }, include: { track: { select: { simplified: true, stats: true } } } }),
  ]);
  const more = batch.length > limit;
  let photos = more ? batch.slice(0, limit) : batch;
  let next: TimelineCursor | null = null;
  if (more) {
    // Drop the trailing partial day so it opens the next page whole (unless the page is a single day).
    const lastDay = photos[photos.length - 1].takenAt!.toISOString().slice(0, 10);
    const firstDay = photos[0].takenAt!.toISOString().slice(0, 10);
    if (firstDay !== lastDay) photos = photos.filter((p) => p.takenAt!.toISOString().slice(0, 10) !== lastDay);
    const last = photos[photos.length - 1];
    next = { after: last.takenAt!, afterId: last.id };
  }
  const undated = more ? [] : await db.photo.findMany({ where: { tripId, ...NOT_TRASHED, status: "READY", takenAt: null }, orderBy: { createdAt: "asc" }, select: photoCardSelect });
  const from = cursor?.after ?? photos[0]?.takenAt ?? null;
  const to = next?.after ?? null;
  // On a paged view only the activities inside the window are shown, so they do not repeat on every page.
  const shownActivities = cursor || more ? activities.filter((a) => (!from || a.endTime > from) && (!to || a.startTime <= to)) : activities;
  return { groups: buildTimeline([...photos, ...undated], shownActivities, timezone), next, paged: Boolean(cursor || more) };
}
