import type { Prisma } from "@/generated/prisma/client";

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

/** Whether the date changed after the job read the row: whoever changed it answered with newer information. */
export function dateMovedSince(before: MemberFields, now: MemberFields): boolean {
  return (
    (before.takenAt?.getTime() ?? null) !== (now.takenAt?.getTime() ?? null) ||
    before.takenAtSource !== now.takenAtSource ||
    before.tzOffsetMin !== now.tzOffsetMin ||
    before.dateSetById !== now.dateSetById
  );
}
