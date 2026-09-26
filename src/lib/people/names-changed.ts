import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Whether what the helper may say about these items changed after a request about them was built.
 *
 * A request carries the names that were permitted when it was built, and a batch can take hours to come back. If
 * meanwhile somebody on the photographs was forgotten (their name scrubbed from the items), untagged, renamed, or
 * withdrew their agreement to be named, the answer may name them again; storing it would undo the very thing that
 * happened in between. So such an answer is thrown away, and the item is described again with the names as they
 * are now.
 */
export async function namesChangedSince(photoIds: string[], since: Date): Promise<boolean> {
  if (!photoIds.length) return false;
  const scrubbed = await db.photo.count({ where: { id: { in: photoIds }, namesScrubbedAt: { gt: since } } });
  if (scrubbed) return true;
  // Anybody on them whose naming changed since: a rename, an opt-out, a consent switch, a birthday (the trigger on
  // Person sets namesChangedAt for exactly those, and nothing else).
  const changed = await db.person.count({
    where: {
      namesChangedAt: { gt: since },
      OR: [{ faces: { some: { photoId: { in: photoIds } } } }, { animals: { some: { photoId: { in: photoIds } } } }],
    },
  });
  return changed > 0;
}

/**
 * The same condition as a filter on the item itself, so the write that stores an answer can carry it: checked and
 * written in one statement, nothing can change in between.
 */
export function unchangedSince(since: Date) {
  const person = { namesChangedAt: { gt: since } };
  return {
    OR: [{ namesScrubbedAt: null }, { namesScrubbedAt: { lte: since } }],
    faces: { none: { person } },
    animals: { none: { person } },
  };
}

/** The advisory lock a forget holds from start to finish (see `withForgetLock`). */
const FORGET_LOCK = 0x666f7267; // "forg"

/**
 * Run a forget holding the forget lock, so no two forgets overlap and no answer is stored while one runs: every write
 * that stores an answer takes the lock shared (see `forgetState`), so a forget waits for writes already under way,
 * and a write that starts after it sees it held. Held by a transaction of its own, it is let go however the forget
 * ends, a crash included.
 */
export async function withForgetLock<T>(fn: () => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FORGET_LOCK}::bigint)`;
      return fn();
    },
    { timeout: 60 * 60_000, maxWait: 10 * 60_000 },
  );
}

/**
 * Read inside the transaction that stores an answer. `underWay`: a forget is running. Which photographs it will touch
 * is not known yet, so nothing is stored; once it has finished, the photographs it touched carry `namesScrubbedAt`
 * (see `unchangedSince`), and only answers about those are thrown away. `reload`: a forget has begun since the
 * forgotten names were read at `loadedAt` (see Tombstone.loadedAt), which may be missing one, so they are read again
 * before anything is stored.
 */
export async function forgetState(tx: Prisma.TransactionClient, loadedAt?: Date): Promise<{ underWay: boolean; reload: boolean }> {
  // Held until this transaction ends, so a forget cannot begin between this check and the write.
  const [{ free }] = await tx.$queryRaw<{ free: boolean }[]>`SELECT pg_try_advisory_xact_lock_shared(${FORGET_LOCK}::bigint) AS free`;
  const rows = await tx.$queryRaw<{ lastForgetAt: Date | null }[]>`SELECT "lastForgetAt" FROM "AppSetting" WHERE id = 'app'`;
  const started = rows[0]?.lastForgetAt;
  return { underWay: !free, reload: Boolean(loadedAt && started && started >= loadedAt) };
}

/** Whether somebody is being forgotten right now: for deciding whether to wait, not for writing. */
export async function forgetRunning(): Promise<boolean> {
  return db.$transaction(async (tx) => !(await tx.$queryRaw<{ free: boolean }[]>`SELECT pg_try_advisory_xact_lock_shared(${FORGET_LOCK}::bigint) AS free`)[0].free);
}
