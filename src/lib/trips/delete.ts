import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { withTryLock } from "@/lib/advisory-lock";
import { isWriteConflict } from "@/lib/db-conflict";
import { forgetTrackFiles } from "@/lib/tracks/files";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";

/**
 * Deleting a trip, in steps, so that a trip of any size lets go of its photographs without one transaction having
 * to rewrite them all (each costs milliseconds: its search columns and both similarity indexes are written again).
 *
 * The trip is first marked as being deleted (`deletingAt`), and in the same statement made private with its links
 * withdrawn, its activities' too: from then on the deletion is decided, visitors have lost it by whatever route they
 * came, members no longer find it listed or open, and nothing files a photograph onto it. Its photographs then leave it a batch at a time, each batch
 * its own transaction, locking its rows in id order as a fold does. The last transaction locks the trip, lets go of
 * whatever was filed onto it since, and deletes it with its activities and tracks: anything filed onto it after that
 * fails on the foreign key. A crash on the way leaves a marked trip with fewer photographs; whoever runs it next —
 * an admin from the Admin page, or the worker (`finishPendingTripDeletions`) — carries on from there. Only a trip of
 * a few hundred photographs is finished inside the admin's request; a bigger one is left to the worker at once.
 */

/** Photographs let go of per transaction: a few seconds of row locks at most, however many there are. */
const BATCH = 200;
/** One run of the steps for a trip at a time (see withTryLock). */
const TRIP_DELETE_LOCK = 0x74726474; // "trdt"
/** The last step only lets go of what was filed since the batches: little, unless somebody filed a great deal. */
const LAST_STEP_TX = { timeout: 120_000, maxWait: 10_000 };
const ATTEMPTS = 3;
/** Up to this many photographs the whole deletion runs in the admin's request: a few seconds. */
export const INLINE_LIMIT = 500;

/**
 * Off the trip: its activities go with it, and a choice about them goes too, or a photo left on no trip would carry
 * a setter that reads as "kept off by hand" wherever it is filed next. Its tracks go as well, and with them the
 * positions they gave (as deleting a track does, see takeBackTrack): a photo off the trip is not left pinned to a
 * route the album no longer has.
 */
const offTrip = Prisma.sql`
  "tripId" = NULL, "activityId" = NULL, "activitySetById" = NULL,
  lat = CASE WHEN "gpsSource" = 'TRACK' THEN NULL ELSE lat END,
  lng = CASE WHEN "gpsSource" = 'TRACK' THEN NULL ELSE lng END,
  altitude = CASE WHEN "gpsSource" = 'TRACK' THEN NULL ELSE altitude END,
  "placeEstimatedAt" = CASE WHEN "gpsSource" = 'TRACK' AND "placeEstimateName" IS NOT NULL THEN NULL ELSE "placeEstimatedAt" END,
  "gpsSource" = CASE WHEN "gpsSource" = 'TRACK' THEN NULL ELSE "gpsSource" END,
  "updatedAt" = now()`;

async function lastStep(tripId: string): Promise<{ originalFile: string | null }[] | null> {
  return db.$transaction(async (tx) => {
    // Locked first, so a photo filed onto it or one of its activities meanwhile is either let go of here or refused
    // because the trip is gone — never left behind with a setter.
    const [trip] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Trip" WHERE id = ${tripId} FOR UPDATE`;
    if (!trip) return null;
    const files = await tx.track.findMany({ where: { tripId }, select: { originalFile: true } });
    await tx.$executeRaw`UPDATE "Photo" SET ${offTrip} WHERE id IN (SELECT id FROM "Photo" WHERE "tripId" = ${tripId} ORDER BY id FOR UPDATE)`;
    await tx.trip.deleteMany({ where: { id: tripId } });
    return files;
  }, LAST_STEP_TX);
}

/**
 * The batches and the last step for a trip marked as being deleted. "busy" while another run holds it (that run
 * finishes it), "gone" when there is no such trip (or another run deleted it), "not-begun" for one nobody deleted.
 */
export async function finishTripDeletion(tripId: string): Promise<"done" | "busy" | "gone" | "not-begun"> {
  const run = await withTryLock({ space: TRIP_DELETE_LOCK, id: tripId }, async () => {
    for (let attempt = 1; ; attempt++) {
      const trip = await db.trip.findUnique({ where: { id: tripId }, select: { deletingAt: true } });
      if (!trip) return "gone" as const;
      if (!trip.deletingAt) return "not-begun" as const;
      // Each batch only touches what is still on the trip, so a batch run again, or that lost a deadlock, is harmless.
      for (;;) {
        const n = await db.$executeRaw`UPDATE "Photo" SET ${offTrip} WHERE id IN (SELECT id FROM "Photo" WHERE "tripId" = ${tripId} ORDER BY id LIMIT ${BATCH} FOR UPDATE)`.catch((err: unknown) => {
          if (isWriteConflict(err)) return -1;
          throw err;
        });
        // A short batch means they have run out: anything filed onto it since is the last step's, which lets go of
        // everything under the trip's lock, so a writer that keeps filing cannot keep this loop going.
        if (n >= 0 && n < BATCH) break;
      }
      try {
        return (await lastStep(tripId)) ?? ("gone" as const);
      } catch (err) {
        if (attempt >= ATTEMPTS || !isWriteConflict(err)) throw err;
      }
    }
  });
  if (!run.ran) return "busy";
  if (typeof run.value === "string") return run.value;
  // Its tracks went with it, so the files they were read from have nothing left to belong to. One left behind by a
  // crash here is found by the orphan-file sweep.
  await forgetTrackFiles(run.value.map((f) => f.originalFile));
  return "done";
}

/**
 * Mark the trip as being deleted, and delete it: "done" once it is gone, "later" when the worker finishes it (a big
 * trip, or one another run is finishing).
 */
export async function deleteTripById(tripId: string): Promise<"done" | "later"> {
  // Not through Prisma, so the trip's updatedAt stays: nothing about it needs judging again. Made private with the
  // mark, which re-indexes none of its photographs (see the trip-title trigger): each batch does that as it goes.
  await db.$transaction(async (tx) => {
    const marked = await tx.$executeRaw`UPDATE "Trip" SET "deletingAt" = now(), visibility = 'PRIVATE', "shareToken" = NULL WHERE id = ${tripId} AND "deletingAt" IS NULL`;
    if (marked) await tx.$executeRaw`UPDATE "Activity" SET "shareToken" = NULL WHERE "tripId" = ${tripId} AND "shareToken" IS NOT NULL`;
  });
  if ((await db.photo.count({ where: { tripId } })) > INLINE_LIMIT) {
    // A queue that is down is no loss: the quarter-hourly pass finds the mark anyway.
    await enqueue(QUEUES.finishRemovals, {}, { singletonKey: "finish-removals", singletonSeconds: 5, singletonNextSlot: true }).catch((err) => {
      console.error("[trips] could not queue the rest of a deletion; the quarter-hourly pass will finish it", err instanceof Error ? err.message : err);
    });
    return "later";
  }
  return (await finishTripDeletion(tripId)) === "busy" ? "later" : "done";
}

/** At worker start and every quarter hour: finish every trip deletion that was interrupted. */
export async function finishPendingTripDeletions(): Promise<number> {
  const pending = await db.trip.findMany({ where: { deletingAt: { not: null } }, orderBy: { deletingAt: "asc" }, select: { id: true } });
  let done = 0;
  for (const t of pending) {
    try {
      if ((await finishTripDeletion(t.id)) === "done") done++;
    } catch (err) {
      console.error("[trips] could not finish deleting a trip; tried again later", err instanceof Error ? err.message : err);
    }
  }
  return done;
}
