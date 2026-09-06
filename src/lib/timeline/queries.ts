import { db } from "@/lib/db";
import { photoCardSelect } from "@/lib/photos/queries";
import { buildTimeline } from "./build";
import type { TimelineGroups } from "@/components/timeline/Timeline";

export async function tripTimeline(tripId: string, timezone: string): Promise<TimelineGroups> {
  const [photos, activities] = await Promise.all([
    db.photo.findMany({ where: { tripId, status: "READY" }, select: photoCardSelect }),
    db.activity.findMany({ where: { tripId }, include: { track: { select: { simplified: true, stats: true } } } }),
  ]);
  return buildTimeline(photos, activities, timezone);
}
