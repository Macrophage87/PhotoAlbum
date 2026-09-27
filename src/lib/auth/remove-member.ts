import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { withTryLock } from "@/lib/advisory-lock";
import { forgetJudgedNames } from "@/lib/annotation/rejudge";
import { revokeRemovedConnection } from "@/lib/google/account";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { isWriteConflict } from "@/lib/db-conflict";
import { revokePending } from "@/lib/google/pending-revoke";

/**
 * Removing a member, in steps, so that it takes as long as their uploads need and never more than a few seconds of
 * any one transaction. Rewriting a photograph costs milliseconds (its search columns and both similarity indexes are
 * written again), so a member with tens of thousands could not be handed over inside one transaction.
 *
 * 1. `beginRemoval`, one short transaction: both accounts locked in id order; a member already gone is nothing to
 *    do; an acting admin removed or demoted meanwhile is refused; never the last admin. The member is marked as being
 *    removed, with who takes over what they made (`removingById`, the acting admin), no longer an admin, and signed
 *    out everywhere; the invitations they sent go, and their Google connection stops being used. From here on the
 *    removal is decided: nothing undoes it, and whatever interrupts it is finished later from the same mark — by an
 *    admin pressing Remove again, or by the worker (`finishPendingRemovals`). Only a member with a few hundred
 *    photographs is finished inside the admin's request; anybody bigger is left to the worker at once, so the page
 *    answers "Being removed" rather than a request that runs for minutes.
 * 2. `handOver`: their photographs pass to the admin a batch at a time, each batch its own transaction, locking its
 *    rows in id order as a fold does. Every batch only moves what still names them, so running it again, or
 *    beside another run, does nothing twice.
 * 3. The last transaction locks both accounts again, hands over whatever named them since (an upload of theirs still
 *    in flight, a fold copying their choice onto a keeper), and deletes the account. Anything that tries to name
 *    them afterwards fails on the foreign key. Google is told only once that has committed; the sealed token is kept
 *    in the same transaction (PendingRevoke) until Google has been told, so a crash right after cannot lose it.
 *
 * A crash between the steps leaves a member marked as being removed, signed out and unable to sign in (see
 * `verifyMagicLink` and `readSessionUser`), with some of their photographs already the admin's: the next run
 * carries on from there.
 */

/** Photographs handed over per transaction: a few seconds of row locks at most, however many there are. */
const BATCH = 200;
/** Smaller rows, handed over in bigger batches. */
const ROW_BATCH = 5000;
/** One run of the steps for a member at a time (see withTryLock). */
const REMOVAL_LOCK = 0x726d6d62; // "rmmb"
/** The last step reads the whole photo table for their choices on others' photographs: seconds on a big album. */
const LAST_STEP_TX = { timeout: 120_000, maxWait: 10_000 };
/** How often the last step is tried again after a deadlock or write conflict with something changing the same rows. */
const ATTEMPTS = 3;
/** Up to this many uploads the whole removal runs in the admin's request: a few seconds. */
export const INLINE_LIMIT = 500;

export class RemovalRefused extends Error {}

/**
 * What of theirs a photograph carries, handed over: their uploads and their choices pass to whoever takes over.
 * Their choices stay choices: left to the foreign keys these setters would be emptied, and an empty setter means the
 * album's own guess — a photo they took off an activity put straight back on it, a place they removed filled in
 * again, a date they fixed re-read. Who last edited or trashed it is forgotten, as deleting the account does.
 */
const handedOver = (member: string, heir: string) => Prisma.sql`
  "uploaderId" = CASE WHEN "uploaderId" = ${member} THEN ${heir} ELSE "uploaderId" END,
  "activitySetById" = CASE WHEN "activitySetById" = ${member} THEN ${heir} ELSE "activitySetById" END,
  "placeSetById" = CASE WHEN "placeSetById" = ${member} THEN ${heir} ELSE "placeSetById" END,
  "dateSetById" = CASE WHEN "dateSetById" = ${member} THEN ${heir} ELSE "dateSetById" END,
  "editedById" = NULLIF("editedById", ${member}),
  "trashedById" = NULLIF("trashedById", ${member})`;
/** Their choices and marks on photographs, whoever uploaded them. */
const namesThem = (member: string) =>
  Prisma.sql`("activitySetById" = ${member} OR "placeSetById" = ${member} OR "dateSetById" = ${member} OR "editedById" = ${member} OR "trashedById" = ${member})`;

/**
 * Step one. False when the member is already gone. A member already being removed is carried on with as it was
 * begun, by whichever admin asks.
 */
async function beginRemoval(actorId: string, memberId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    // Both accounts locked, in one order, so two admins removing each other take turns: the second finds itself
    // demoted and being removed.
    const users = await tx.$queryRaw<{ id: string; role: string; email: string; removingAt: Date | null }[]>`
      SELECT id, role::text AS role, email, "removingAt" FROM "User" WHERE id IN (${actorId}, ${memberId}) ORDER BY id FOR UPDATE`;
    const member = users.find((u) => u.id === memberId);
    if (!member) return false;
    if (users.find((u) => u.id === actorId)?.role !== "ADMIN") throw new RemovalRefused("Your account is no longer an admin's.");
    if (member.removingAt) return true;
    // Never the last admin: somebody has to be able to run the album.
    const [{ admins }] = await tx.$queryRaw<{ admins: number }[]>`SELECT count(*)::int AS admins FROM "User" WHERE role = 'ADMIN' AND "removingAt" IS NULL AND id <> ${memberId}`;
    if (!admins) throw new RemovalRefused("The album needs at least one admin.");
    // Somebody still taking over a removed member's photographs stays until that is finished (removeMemberAs finishes
    // it first; this is the rare one that began meanwhile). Nothing could be handed to an account that is gone.
    const [{ heirs }] = await tx.$queryRaw<{ heirs: number }[]>`SELECT count(*)::int AS heirs FROM "User" WHERE "removingById" = ${memberId}`;
    if (heirs) throw new RemovalRefused("They are still taking over the photographs of a member being removed; try again in a minute.");
    await tx.$executeRaw`UPDATE "User" SET role = 'MEMBER', "removingAt" = now(), "removingById" = ${actorId} WHERE id = ${memberId}`;
    // Signed out now, so nothing more of theirs is saved while the rest is handed over.
    await tx.session.deleteMany({ where: { userId: memberId } });
    await tx.magicLinkToken.deleteMany({ where: { email: member.email } });
    // Nobody joins on their word any more: their pending invitations went with the account before, and would now
    // outlive the mark by as long as the hand-over takes (see verifyMagicLink for one sent at this very moment).
    await tx.invite.deleteMany({ where: { invitedById: memberId, acceptedAt: null } });
    // Nor is their Google connection used again, by a Picker download already queued say (see accessTokenFor). The
    // grant itself is revoked once the account has gone.
    await tx.googleAccount.updateMany({ where: { userId: memberId }, data: { needsReconnect: true } });
    return true;
  });
}

/** Run a batch until it has nothing left to do. */
async function drain(size: number, batch: () => Promise<number>): Promise<void> {
  // A batch that loses a deadlock is simply run again; the next one picks up what it left. A short batch means the
  // rows have run out: whatever arrives after it (a member's saves still landing) is the last step's, which hands
  // over everything under lock — so a writer that keeps adding rows cannot keep this loop going.
  for (;;) {
    const n = await batch().catch((err: unknown) => {
      if (isWriteConflict(err)) return -1;
      throw err;
    });
    if (n >= 0 && n < size) return;
  }
}

/** Step two: everything that names them and is big enough to need it, a batch at a time. */
async function handOver(member: string, heir: string): Promise<void> {
  const set = handedOver(member, heir);
  // Each batch picks and locks its rows in a CTE, which Postgres runs exactly once. The same pick as an IN (...)
  // subquery may be run again for every row the planner joins it to, and each run passes over the rows this very
  // statement has just changed and locks the next ones: one "batch" then took every row, however many.
  await drain(BATCH, () => db.$executeRaw`WITH picked AS (SELECT id FROM "Photo" WHERE "uploaderId" = ${member} ORDER BY id LIMIT ${BATCH} FOR UPDATE) UPDATE "Photo" SET ${set} FROM picked WHERE "Photo".id = picked.id`);
  await drain(BATCH, () => db.$executeRaw`WITH picked AS (SELECT id FROM "Photo" WHERE ${namesThem(member)} ORDER BY id LIMIT ${BATCH} FOR UPDATE) UPDATE "Photo" SET ${set} FROM picked WHERE "Photo".id = picked.id`);
  await drain(ROW_BATCH, () => db.$executeRaw`WITH picked AS (SELECT id FROM "CollectionItem" WHERE "addedById" = ${member} ORDER BY id LIMIT ${ROW_BATCH} FOR UPDATE) UPDATE "CollectionItem" SET "addedById" = ${heir} FROM picked WHERE "CollectionItem".id = picked.id`);
  // Their visits stay counted, as nobody's — what deleting the account does to them anyway.
  await drain(ROW_BATCH, () => db.$executeRaw`WITH picked AS (SELECT id FROM "Visit" WHERE "userId" = ${member} ORDER BY id LIMIT ${ROW_BATCH} FOR UPDATE) UPDATE "Visit" SET "userId" = NULL FROM picked WHERE "Visit".id = picked.id`);
}

/** Step three. Null when somebody else's run got there first. */
async function lastStep(member: string, heir: string): Promise<{ revoke: string | null } | null> {
  return db.$transaction(async (tx) => {
    // In id order, as every step that locks accounts; nothing can name them after this commits.
    const users = await tx.$queryRaw<{ id: string; email: string }[]>`SELECT id, email FROM "User" WHERE id IN (${heir}, ${member}) ORDER BY id FOR UPDATE`;
    const gone = users.find((u) => u.id === member);
    if (!gone) return null;
    const set = handedOver(member, heir);
    await tx.$executeRaw`WITH picked AS (SELECT id FROM "Photo" WHERE "uploaderId" = ${member} OR ${namesThem(member)} ORDER BY id FOR UPDATE) UPDATE "Photo" SET ${set} FROM picked WHERE "Photo".id = picked.id`;
    await tx.collectionItem.updateMany({ where: { addedById: member }, data: { addedById: heir } });
    await tx.track.updateMany({ where: { uploaderId: member }, data: { uploaderId: heir } });
    await tx.trip.updateMany({ where: { createdById: member }, data: { createdById: heir } });
    await tx.collection.updateMany({ where: { createdById: member }, data: { createdById: heir } });
    await tx.invite.deleteMany({ where: { invitedById: member, acceptedAt: null } });
    // Kept, sealed, until Google has been told: committed with the delete, so no crash can lose it.
    const [revoke] = await tx.$queryRaw<{ id: string }[]>`
      WITH gone AS (DELETE FROM "GoogleAccount" WHERE "userId" = ${member} RETURNING "encryptedRefreshToken")
      INSERT INTO "PendingRevoke" (id, "userId", "encryptedRefreshToken") SELECT gen_random_uuid()::text, ${member}, "encryptedRefreshToken" FROM gone RETURNING id`;
    // Their name, recorded as judged, goes with them.
    await forgetJudgedNames(tx, `user:${member}`);
    await tx.user.delete({ where: { id: member } });
    await tx.magicLinkToken.deleteMany({ where: { email: gone.email } });
    return { revoke: revoke?.id ?? null };
  }, LAST_STEP_TX);
}

/**
 * Steps two and three for a member marked as being removed. "busy" while another run holds them (it finishes the
 * job), "gone" when there is nobody to remove, "not-begun" for a member nobody asked to remove.
 */
export async function finishRemoval(memberId: string): Promise<"done" | "busy" | "gone" | "not-begun"> {
  const run = await withTryLock({ space: REMOVAL_LOCK, id: memberId }, async () => {
    for (let attempt = 1; ; attempt++) {
      const member = await db.user.findUnique({ where: { id: memberId }, select: { removingAt: true, removingById: true } });
      if (!member) return "gone" as const;
      if (!member.removingAt || !member.removingById) return "not-begun" as const;
      await handOver(memberId, member.removingById);
      try {
        return (await lastStep(memberId, member.removingById)) ?? ("gone" as const);
      } catch (err) {
        // A deadlock with something writing their photographs meanwhile: hand over what it wrote, and try again.
        if (attempt >= ATTEMPTS || !isWriteConflict(err)) throw err;
      }
    }
  });
  if (!run.ran) return "busy";
  if (typeof run.value === "string") return run.value;
  // Revoked at Google only once they are gone: a removal that has not finished leaves them connected. One Google
  // could not be told about stays pending, and the worker tries it again (revokePendingConnections).
  if (run.value.revoke) await revokePending(run.value.revoke);
  else await revokeRemovedConnection(memberId, null);
  return "done";
}

/** Their uploads: what decides whether the admin's request finishes the removal or leaves it to the worker. */
const uploadsOf = (memberId: string) => db.photo.count({ where: { uploaderId: memberId } });

/** Hand a removal to the worker now. A queue that is down is no loss: the quarter-hourly pass finds the mark anyway. */
async function finishLater(): Promise<void> {
  await enqueue(QUEUES.finishRemovals, {}, { singletonKey: "finish-removals", singletonSeconds: 5, singletonNextSlot: true }).catch((err) => {
    console.error("[admin] could not queue the rest of a removal; the quarter-hourly pass will finish it", err instanceof Error ? err.message : err);
  });
}

/**
 * Remove a member, keeping their uploads and what they made: handed over to the acting admin. Whoever is still
 * taking over from a removal that was interrupted has that finished first, when it is small. "done" once they are
 * gone (or were already); "later" when the worker finishes it — a big one, or one another run is finishing.
 */
export async function removeMemberAs(actorId: string, memberId: string): Promise<"done" | "later"> {
  for (const pending of await db.user.findMany({ where: { removingById: memberId }, select: { id: true } })) {
    if ((await uploadsOf(pending.id)) > INLINE_LIMIT) {
      await finishLater();
      throw new RemovalRefused("They are still taking over the photographs of a member being removed; try again once that has finished.");
    }
    await finishRemoval(pending.id);
  }
  // A write conflict or deadlock with another admin's step is tried once more.
  const begun = await beginRemoval(actorId, memberId).catch((err: unknown) => {
    if (isWriteConflict(err)) return beginRemoval(actorId, memberId);
    throw err;
  });
  if (!begun) return "done";
  if ((await uploadsOf(memberId)) > INLINE_LIMIT) {
    await finishLater();
    return "later";
  }
  const finished = await finishRemoval(memberId);
  return finished === "busy" ? "later" : "done";
}

/** At worker start and every quarter hour: finish every removal that was interrupted. One that fails is tried next time. */
export async function finishPendingRemovals(): Promise<number> {
  const pending = await db.user.findMany({ where: { removingAt: { not: null } }, orderBy: { removingAt: "asc" }, select: { id: true } });
  let done = 0;
  for (const u of pending) {
    try {
      if ((await finishRemoval(u.id)) === "done") done++;
    } catch (err) {
      console.error("[admin] could not finish removing a member; tried again later", err instanceof Error ? err.message : err);
    }
  }
  return done;
}
