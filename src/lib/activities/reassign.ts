import { db } from "@/lib/db";

/**
 * Keep photo <-> activity links consistent with an activity's time window:
 * photos that fell out of the window are detached, unassigned photos inside it are attached.
 */
export async function reassignPhotosForActivity(activityId: string): Promise<void> {
  const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true, tripId: true, startTime: true, endTime: true } });
  if (!activity) return;
  await db.photo.updateMany({
    where: { activityId: activity.id, OR: [{ takenAt: null }, { takenAt: { lt: activity.startTime } }, { takenAt: { gt: activity.endTime } }] },
    data: { activityId: null },
  });
  await db.photo.updateMany({
    where: { tripId: activity.tripId, activityId: null, takenAt: { gte: activity.startTime, lte: activity.endTime } },
    data: { activityId: activity.id },
  });
}
