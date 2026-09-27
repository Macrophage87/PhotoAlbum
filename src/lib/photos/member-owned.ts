import type { Prisma } from "@/generated/prisma/client";
import { offsetMinutesInZone } from "@/lib/time/local-day";

/**
 * What a processing job may and may not write back over, once its slow part (reading the file, rendering, ffmpeg) is
 * done. The job read the row when it started; a member may have dated it, pinned or cleared its place, or filed it on
 * an activity since. Those are the member's answers, so the job's write re-reads the row locked (`lockedPhoto`) and
 * works from that, never from the copy it started with.
 */

/** The fields a member's date, place and filing choices live in. */
export type MemberFields = {
  takenAt: Date | null;
  takenAtSource: string | null;
  tzOffsetMin: number | null;
  dateSetById: string | null;
  lat: number | null;
  lng: number | null;
  gpsSource: string | null;
  placeSetById: string | null;
  tripId: string | null;
  activityId: string | null;
  activitySetById: string | null;
};

/** Lock the row for the rest of the transaction and read it as it is now; null when it is gone. */
export async function lockedPhoto(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM "Photo" WHERE id = ${id} FOR UPDATE`;
  return tx.photo.findUnique({ where: { id } });
}

/** A date a member gave: typed or picked by hand. Nothing a job reads out of the file replaces it. */
export function dateByHand(p: Pick<MemberFields, "takenAtSource" | "dateSetById">): boolean {
  return p.takenAtSource === "MANUAL" || p.dateSetById !== null;
}

/** A place a member pinned, or took away. The file's own GPS does not come back over it. */
export function placeByHand(p: Pick<MemberFields, "gpsSource" | "placeSetById">): boolean {
  return p.gpsSource === "MANUAL" || p.placeSetById !== null;
}

/**
 * Whether a member moved the item to another trip, or took it off one, after its job was queued with the trip the
 * row had then. A job can wait a long while behind an import; the row's trip is the member's answer and stands, and
 * an item taken off a trip is not filed again by its day.
 */
export function tripChangedSinceQueued(job: { tripId?: string | null }, row: Pick<MemberFields, "tripId">): boolean {
  return Boolean(job.tripId) && job.tripId !== row.tripId;
}

/** Whether the date changed after the job read the row: whoever changed it answered with newer information. */
export function dateMovedSince(before: MemberFields, now: MemberFields): boolean {
  return (
    (before.takenAt?.getTime() ?? null) !== (now.takenAt?.getTime() ?? null) ||
    before.takenAtSource !== now.takenAtSource ||
    before.tzOffsetMin !== now.tzOffsetMin ||
    before.dateSetById !== now.dateSetById
  );
}

/**
 * The offset for a kept date that has none recorded: the zone of the trip the item ends up on, at that instant, as the
 * job would have given it. Only the offset is filled in, never the date. Null when it has one already, or there is no
 * trip to take one from.
 */
export async function offsetForKeptDate(tx: Prisma.TransactionClient, now: Pick<MemberFields, "takenAt" | "tzOffsetMin">, tripId: string | null): Promise<number | null> {
  if (now.tzOffsetMin !== null || !now.takenAt || !tripId) return null;
  const trip = await tx.trip.findUnique({ where: { id: tripId }, select: { timezone: true } });
  return trip ? offsetMinutesInZone(now.takenAt, trip.timezone) : null;
}
