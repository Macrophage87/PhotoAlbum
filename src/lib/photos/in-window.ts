import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { NOT_TRASHED } from "@/lib/photos/trash";
import { isAdmin } from "@/lib/auth/ownership";
import type { ViewerUser } from "@/lib/auth/viewer";
import { dateColumnToDay, localDayFromOffset, localDayInZone } from "@/lib/time/local-day";

/**
 * The photographs taken while something was happening that are not on it yet: "everything from that afternoon's
 * walk", "everything from the fortnight".
 *
 * Only what is free to take is offered. A photograph on some other trip was put there — by the date it carries, or
 * by somebody's hand — and sweeping it across because the clocks overlap would undo that without anybody noticing;
 * two families' trips to the same place in the same week are the usual case. Those are counted, so the page can say
 * they exist and where to find them, and picked one at a time if they really belong here. And, as everywhere, only
 * a member's own photographs are moved, or anyone's by an admin.
 */
export type WindowCandidates = { ids: string[]; elsewhere: number };

type User = Pick<ViewerUser, "id" | "role">;

const mine = (user: User): Prisma.PhotoWhereInput => (isAdmin(user) ? {} : { uploaderId: user.id });

/** Taken between the activity's start and end, on no trip or on the activity's own trip, and not on it already. */
export async function activityWindow(user: User, activity: { id: string; tripId: string; startTime: Date; endTime: Date }): Promise<WindowCandidates> {
  const during: Prisma.PhotoWhereInput = { status: "READY", ...NOT_TRASHED, takenAt: { gte: activity.startTime, lte: activity.endTime }, ...mine(user) };
  const [free, elsewhere] = await Promise.all([
    db.photo.findMany({
      where: { ...during, OR: [{ tripId: null }, { tripId: activity.tripId, OR: [{ activityId: null }, { activityId: { not: activity.id } }] }] },
      select: { id: true },
      orderBy: { takenAt: "asc" },
    }),
    db.photo.count({ where: { ...during, tripId: { not: activity.tripId } } }),
  ]);
  return { ids: free.map((p) => p.id), elsewhere };
}

/**
 * Taken on one of the trip's days, where the day is the one where the photograph was taken — its own clock's offset
 * when it has one, the trip's time zone when not — and on no trip at all.
 */
export async function tripWindow(user: User, trip: { id: string; startDate: Date; endDate: Date; timezone: string }): Promise<WindowCandidates> {
  const first = dateColumnToDay(trip.startDate);
  const last = dateColumnToDay(trip.endDate);
  // A day either side, because a local day starts up to fourteen hours either side of the UTC one; the exact test
  // is done below on each photograph's own day.
  const from = new Date(trip.startDate.getTime() - 86_400_000);
  const to = new Date(trip.endDate.getTime() + 2 * 86_400_000);
  const rows = await db.photo.findMany({
    where: { status: "READY", ...NOT_TRASHED, takenAt: { gte: from, lt: to }, ...mine(user), OR: [{ tripId: null }, { tripId: { not: trip.id } }] },
    select: { id: true, tripId: true, takenAt: true, tzOffsetMin: true },
    orderBy: { takenAt: "asc" },
  });
  const ids: string[] = [];
  let elsewhere = 0;
  for (const p of rows) {
    const day = p.tzOffsetMin !== null ? localDayFromOffset(p.takenAt!, p.tzOffsetMin) : localDayInZone(p.takenAt!, trip.timezone);
    if (day < first || day > last) continue;
    if (p.tripId === null) ids.push(p.id);
    else elsewhere++;
  }
  return { ids, elsewhere };
}
