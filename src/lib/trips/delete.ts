import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { withTryLock } from "@/lib/advisory-lock";
import { isWriteConflict } from "@/lib/db-conflict";
import { forgetTrackFiles } from "@/lib/tracks/files";

/**
 * Deleting a trip, in steps, so that a trip of any size lets go of its photographs without one transaction having
 * to rewrite them all (each costs milliseconds: its search columns and both similarity indexes are written again).
 *
 * The trip is first marked as being deleted (`deletingAt`); from then on the deletion is decided, and filing a
 * photograph by its date passes it over. Its photographs then leave it a batch at a time, each batch
 * its own transaction, locking its rows in id order as a fold does. The last transaction locks the trip, lets go of
 * whatever was filed onto it since, and deletes it with its activities and tracks: anything filed onto it after that
 * fails on the foreign key. A crash on the way leaves a marked trip with fewer photographs; whoever runs it next —
 * an admin pressing Delete again, or the worker (`finishPendingTripDeletions`) — carries on from there.
 */

/** Photographs let go of per transaction: a few seconds of row locks at most, however many there are. */
const BATCH = 200;
/** One run of the steps for a trip at a time (see withTryLock). */
const TRIP_DELETE_LOCK = 0x74726474; // "trdt"
/** The last step only lets go of what was filed since the batches: little, unless somebody filed a great deal. */
const LAST_STEP_TX = { timeout: 120_000, maxWait: 10_000 };
const ATTEMPTS = 3;

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
        if (n === 0) break;
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

/** Mark the trip as being deleted, and delete it. Returns once it is gone, or once another run is finishing it. */
export async function deleteTripById(tripId: string): Promise<void> {
  // Not through Prisma, so the trip's updatedAt stays: nothing about it needs judging again.
  await db.$executeRaw`UPDATE "Trip" SET "deletingAt" = now() WHERE id = ${tripId} AND "deletingAt" IS NULL`;
  await finishTripDeletion(tripId);
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
