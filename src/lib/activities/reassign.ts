import { db } from "@/lib/db";

/**
 * Keep photo <-> activity links consistent with an activity's time window and with who was on it:
 * photos that fell out of the window are detached, unassigned photos inside it are attached.
 *
 * An item a member put in the activity themselves — uploaded into it, or filed there on its own page — is left
 * alone in both directions. Otherwise a scan with no date, or a photograph taken before the walk set off, would be
 * quietly thrown out again the next time anyone edited the activity's times.
 *
 * Where the outing names who was on it, only their photographs are gathered, and anything the clock swept in from
 * somebody who was not there goes back to the trip. That last part is the point of naming them after the fact: a
 * list added this evening tidies up what the hours collected this afternoon.
 */
export async function reassignPhotosForActivity(activityId: string): Promise<void> {
  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: { id: true, tripId: true, startTime: true, endTime: true, participants: { select: { id: true } } },
  });
  if (!activity) return;
  const there = activity.participants.map((p) => p.id);
  const outside = [
    { takenAt: null },
    { takenAt: { lt: activity.startTime } },
    { takenAt: { gt: activity.endTime } },
    ...(there.length ? [{ uploaderId: { notIn: there } }] : []),
  ];
  await db.photo.updateMany({
    where: { activityId: activity.id, activitySetById: null, OR: outside },
    data: { activityId: null },
  });
  await db.photo.updateMany({
    where: {
      tripId: activity.tripId,
      activityId: null,
      takenAt: { gte: activity.startTime, lte: activity.endTime },
      ...(there.length ? { uploaderId: { in: there } } : {}),
    },
    data: { activityId: activity.id },
  });
}
