import { db } from "@/lib/db";
import { photoCardSelect } from "@/lib/photos/queries";
import { buildTimeline } from "./build";
import type { TimelineGroups } from "@/components/timeline/Timeline";
import { NOT_TRASHED } from "@/lib/photos/trash";

/**
 * A trip's whole timeline: every dated photograph in capture order, then the undated ones, with the trip's
 * activities in place.
 *
 * It used to come back four hundred photographs at a time, cut at a day boundary, with a "Later days" link at the
 * bottom — which meant a fortnight in Maine was four pages, the rail down the side listed only the days of the page
 * you happened to be on, and finding the afternoon you were after was a matter of guessing which page it fell in.
 * A timeline is a thing you scroll and scan; it is shown whole, and the panel beside it navigates it.
 */
export async function tripTimeline(tripId: string, timezone: string): Promise<TimelineGroups> {
  const [dated, undated, activities] = await Promise.all([
    db.photo.findMany({
      where: { tripId, ...NOT_TRASHED, status: "READY", takenAt: { not: null } },
      orderBy: [{ takenAt: "asc" }, { id: "asc" }],
      select: photoCardSelect,
    }),
    db.photo.findMany({ where: { tripId, ...NOT_TRASHED, status: "READY", takenAt: null }, orderBy: { createdAt: "asc" }, select: photoCardSelect }),
    db.activity.findMany({ where: { tripId }, orderBy: { startTime: "asc" }, include: { track: { select: { simplified: true, stats: true } } } }),
  ]);
  return buildTimeline([...dated, ...undated], activities, timezone);
}
