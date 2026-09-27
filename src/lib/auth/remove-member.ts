import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { withTryLock } from "@/lib/advisory-lock";
import { forgetJudgedNames } from "@/lib/annotation/rejudge";
import { revokeRemovedConnection } from "@/lib/google/account";
import { enqueue } from "@/lib/jobs/boss";
import { QUEUES } from "@/lib/jobs/queues";
import { isWriteConflict } from "@/lib/db-conflict";

/**
 * Removing a member, in steps, so that it takes as long as their uploads need and never more than a few seconds of
 * any one transaction. Rewriting a photograph costs milliseconds (its search columns and both similarity indexes are
 * written again), so a member with tens of thousands could not be handed over inside one transaction.
 *
 * 1. `beginRemoval`, one short transaction: both accounts locked in id order; a member already gone is nothing to
 *    do; an acting admin removed or demoted meanwhile is refused; never the last admin. The member is marked as being
 *    removed, with who takes over what they made (`removingById`, the acting admin), no longer an admin, and signed
 *    out everywhere. From here on the removal is decided: nothing undoes it, and whatever interrupts it is finished
 *    later from the same mark — by an admin pressing Remove again, or by the worker (`finishPendingRemovals`).
 * 2. `handOver`: their photographs pass to the admin a batch at a time, each batch its own transaction, locking its
 *    rows in id order as a fold does. Every batch only moves what still names them, so running it again, or
 *    beside another run, does nothing twice.
 * 3. The last transaction locks both accounts again, hands over whatever named them since (an upload of theirs still
 *    in flight, a fold copying their choice onto a keeper), and deletes the account. Anything that tries to name
 *    them afterwards fails on the foreign key. Google is told only once that has committed.
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
    return true;
  });
}

/** Run a batch until it has nothing left to do. */
async function drain(batch: () => Promise<number>): Promise<void> {
  // A batch that loses a deadlock is simply run again; the next one picks up what it left.
  for (;;) {
    const n = await batch().catch((err: unknown) => {
      if (isWriteConflict(err)) return -1;
      throw err;
    });
    if (n === 0) return;
  }
}

/** Step two: everything that names them and is big enough to need it, a batch at a time. */
async function handOver(member: string, heir: string): Promise<void> {
  const set = handedOver(member, heir);
  await drain(() => db.$executeRaw`UPDATE "Photo" SET ${set} WHERE id IN (SELECT id FROM "Photo" WHERE "uploaderId" = ${member} ORDER BY id LIMIT ${BATCH} FOR UPDATE)`);
  await drain(() => db.$executeRaw`UPDATE "Photo" SET ${set} WHERE id IN (SELECT id FROM "Photo" WHERE ${namesThem(member)} ORDER BY id LIMIT ${BATCH} FOR UPDATE)`);
  await drain(() => db.$executeRaw`UPDATE "CollectionItem" SET "addedById" = ${heir} WHERE id IN (SELECT id FROM "CollectionItem" WHERE "addedById" = ${member} ORDER BY id LIMIT ${ROW_BATCH} FOR UPDATE)`);
  // Their visits stay counted, as nobody's — what deleting the account does to them anyway.
  await drain(() => db.$executeRaw`UPDATE "Visit" SET "userId" = NULL WHERE id IN (SELECT id FROM "Visit" WHERE "userId" = ${member} ORDER BY id LIMIT ${ROW_BATCH} FOR UPDATE)`);
}

/** Step three. Null when somebody else's run got there first. */
async function lastStep(member: string, heir: string): Promise<{ token: string | null } | null> {
  return db.$transaction(async (tx) => {
    // In id order, as every step that locks accounts; nothing can name them after this commits.
    const users = await tx.$queryRaw<{ id: string; email: string }[]>`SELECT id, email FROM "User" WHERE id IN (${heir}, ${member}) ORDER BY id FOR UPDATE`;
    const gone = users.find((u) => u.id === member);
    if (!gone) return null;
    const set = handedOver(member, heir);
    await tx.$executeRaw`UPDATE "Photo" SET ${set} WHERE id IN (SELECT id FROM "Photo" WHERE "uploaderId" = ${member} OR ${namesThem(member)} ORDER BY id FOR UPDATE)`;
    await tx.collectionItem.updateMany({ where: { addedById: member }, data: { addedById: heir } });
    await tx.track.updateMany({ where: { uploaderId: member }, data: { uploaderId: heir } });
    await tx.trip.updateMany({ where: { createdById: member }, data: { createdById: heir } });
    await tx.collection.updateMany({ where: { createdById: member }, data: { createdById: heir } });
    const google = await tx.$queryRaw<{ token: string }[]>`DELETE FROM "GoogleAccount" WHERE "userId" = ${member} RETURNING "encryptedRefreshToken" AS token`;
    // Their name, recorded as judged, goes with them.
    await forgetJudgedNames(tx, `user:${member}`);
    await tx.user.delete({ where: { id: member } });
    await tx.magicLinkToken.deleteMany({ where: { email: gone.email } });
    return { token: google[0]?.token ?? null };
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
  // could not be told about is tried again from the queue, carrying only the sealed token.
  const token = run.value.token;
  if ((await revokeRemovedConnection(memberId, token)) === "failed" && token) {
    await enqueue(QUEUES.revokeGoogle, { encryptedRefreshToken: token }, { retryLimit: 10, retryDelay: 600, retryBackoff: true }).catch((err) => {
      console.error("[admin] could not queue the retry of a removed member's Google revocation", err instanceof Error ? err.message : err);
    });
  }
  return "done";
}

/**
 * Remove a member, keeping their uploads and what they made: handed over to the acting admin. Whoever is still
 * taking over from a removal that was interrupted has that finished first. Returns once they are gone, or once it is
 * clear another run is finishing it.
 */
export async function removeMemberAs(actorId: string, memberId: string): Promise<void> {
  for (const pending of await db.user.findMany({ where: { removingById: memberId }, select: { id: true } })) await finishRemoval(pending.id);
  // A write conflict or deadlock with another admin's step is tried once more.
  const begun = await beginRemoval(actorId, memberId).catch((err: unknown) => {
    if (isWriteConflict(err)) return beginRemoval(actorId, memberId);
    throw err;
  });
  if (begun) await finishRemoval(memberId);
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
