import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { openTo, pickActivityByTime, whoWasThere } from "@/lib/photos/assign";

/**
 * The one place the album files photographs on activities by the clock, and the rules every automatic path shares:
 * the shortest window that covers the moment wins, only outings the uploader was on (or that name nobody) count,
 * and a member's own answer is never overruled.
 *
 * A member's answer is `activitySetById`. With an activity it means "this belongs on that walk"; with none it means
 * "this was on no activity" — somebody took it off by hand — and the hours of whatever covers it leave it loose.
 * Both hold only on the trip they were given on: moving a photograph to another trip is a fresh start.
 */

type Filing = { activityId: string | null; activitySetById: string | null };

/**
 * Where one item belongs once it is (or stays) on `tripId` at `takenAt`: where a member put it, if that still makes
 * sense there, otherwise wherever the clock says.
 */
export async function activityFor(
  photo: { tripId: string | null; activityId: string | null; activitySetById: string | null; uploaderId: string },
  tripId: string | null,
  takenAt: Date | null,
): Promise<Filing> {
  if (photo.activitySetById && tripId) {
    if (!photo.activityId && tripId === photo.tripId) return { activityId: null, activitySetById: photo.activitySetById };
    // An activity chosen by hand holds as long as it is still one of this trip's: it may have been deleted since.
    if (photo.activityId && (await db.activity.count({ where: { id: photo.activityId, tripId } }))) return { activityId: photo.activityId, activitySetById: photo.activitySetById };
  }
  if (!tripId || !takenAt) return { activityId: null, activitySetById: null };
  const activities = await db.activity.findMany({ where: { tripId, ...whoWasThere(photo.uploaderId) }, select: { id: true, startTime: true, endTime: true } });
  return { activityId: pickActivityByTime(activities, takenAt)?.id ?? null, activitySetById: null };
}

/**
 * File every photograph of a trip that the clock is in charge of (nobody chose for it), narrowed by `scope`, on the
 * activity its time falls in — or on none. A photograph the clock put on a long outing moves to a shorter one that
 * now covers it, and one left over when an outing is shortened or deleted goes to whatever else still covers it.
 */
export async function refileByClock(tripId: string, scope: Prisma.PhotoWhereInput = {}): Promise<void> {
  try {
    await refileOnce(tripId, scope);
  } catch (err) {
    // An activity deleted between reading the list and writing to it: read again, once, without it.
    if ((err as { code?: string }).code !== "P2003") throw err;
    await refileOnce(tripId, scope);
  }
}

async function refileOnce(tripId: string, scope: Prisma.PhotoWhereInput): Promise<void> {
  const [activities, photos] = await Promise.all([
    db.activity.findMany({ where: { tripId }, select: { id: true, startTime: true, endTime: true, participants: { select: { id: true } } } }),
    db.photo.findMany({ where: { AND: [{ tripId, activitySetById: null }, scope] }, select: { id: true, takenAt: true, uploaderId: true, activityId: true } }),
  ]);
  const moves: { photo: (typeof photos)[number]; to: string | null }[] = [];
  for (const p of photos) {
    const to = p.takenAt ? pickActivityByTime(openTo(activities, p.uploaderId), p.takenAt)?.id ?? null : null;
    if (to !== p.activityId) moves.push({ photo: p, to });
  }
  // Each written only if it is still as it was read: a member filing it by hand, or correcting its date, while this
  // runs wins, and the change of date files it again on its own.
  for (const { photo: p, to } of moves) {
    await db.photo.updateMany({ where: { id: p.id, tripId, activitySetById: null, activityId: p.activityId, takenAt: p.takenAt }, data: { activityId: to } });
  }
}

type Window = { startTime: Date; endTime: Date };

const during = (w: Window): Prisma.PhotoWhereInput => ({ takenAt: { gte: w.startTime, lte: w.endTime } });

/**
 * Keep photo <-> activity links consistent after an activity is made or its hours or people change: what the clock
 * filed on it that no longer fits goes wherever else it fits, and what the clock can now put on it comes over —
 * from the trip's loose photographs and from longer outings alike. (What only the old hours covered was either on
 * it, and so is looked at, or on a shorter outing, which this change does not affect.)
 *
 * An item a member put in the activity themselves — uploaded into it, or filed there on its own page — is left
 * alone in both directions, as is one a member took off an activity. Otherwise a scan with no date, or a
 * photograph taken before the walk set off, would be quietly thrown out again the next time anyone edited the
 * activity's times.
 *
 * Where the outing names who was on it, only their photographs are gathered, and anything the clock swept in from
 * somebody who was not there goes back to the trip. That last part is the point of naming them after the fact: a
 * list added this evening tidies up what the hours collected this afternoon.
 */
export async function reassignPhotosForActivity(activityId: string): Promise<void> {
  const activity = await db.activity.findUnique({ where: { id: activityId }, select: { id: true, tripId: true, startTime: true, endTime: true } });
  if (!activity) return;
  await refileByClock(activity.tripId, { OR: [{ activityId: activity.id }, during(activity)] });
}

/**
 * Delete an activity and re-file what was on it. A photograph somebody had put on it by hand loses the thing it was
 * put on, so it goes back to the clock like the rest; each lands on whatever other outing covers its time.
 */
export async function deleteActivityAndRefile(activityId: string): Promise<void> {
  const gone = await db.$transaction(async (tx) => {
    // The row is locked first, so a photograph filed on it by hand in the meantime is either seen here and cleared,
    // or refused because the activity is already gone — never left with a setter pointing at nothing.
    const locked = await tx.$queryRaw<{ id: string; tripId: string; startTime: Date; endTime: Date }[]>`SELECT id, "tripId", "startTime", "endTime" FROM "Activity" WHERE id = ${activityId} FOR UPDATE`;
    const activity = locked[0];
    if (!activity) return null;
    const on = (await tx.photo.findMany({ where: { activityId: activity.id }, select: { id: true } })).map((p) => p.id);
    // Cleared first: left to the foreign key, a hand-filed photograph would keep its setter and read as taken off by hand.
    await tx.photo.updateMany({ where: { activityId: activity.id }, data: { activityId: null, activitySetById: null } });
    await tx.activity.deleteMany({ where: { id: activity.id } });
    return { activity, on };
  });
  if (!gone) return;
  await refileByClock(gone.activity.tripId, { OR: [{ id: { in: gone.on } }, during(gone.activity)] });
}
