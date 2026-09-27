import { Client } from "pg";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
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

/** A forget that could not have the lock in time: another person is being forgotten. */
export class ForgetBusyError extends Error {
  constructor() {
    super("Another person is being forgotten; try again in a few minutes.");
  }
}

export type ForgetLockHeld = {
  /** Throws unless the lock is still held (its connection may have dropped): no forget finishes unlocked. */
  assertHeld(): Promise<void>;
};

/**
 * Run a forget holding the forget lock, so no two forgets overlap and no answer is stored while one runs: every write
 * that stores an answer takes the lock shared (see `forgetState`), so a forget waits for writes already under way,
 * and a write that starts after it sees it held.
 *
 * Held by a connection of its own, outside the pool and outside any transaction: a forget waiting its turn ties up
 * none of the pool the running one needs, nothing sits idle in a transaction however long a forget takes, and the
 * lock goes with the connection however the forget ends, a crash included. Not had within a couple of minutes (another
 * forget is taking long), it is refused (`ForgetBusyError`).
 */
export async function withForgetLock<T>(fn: (held: ForgetLockHeld) => Promise<T>, wait: { ms: number } = { ms: 120_000 }): Promise<T> {
  const client = new Client({ connectionString: env().DATABASE_URL });
  let lost = false;
  client.on("error", () => void (lost = true));
  await client.connect();
  try {
    // Waited for in line, not polled: once a forget is queued for it, new shared holds (answers being stored) step
    // aside, so it cannot be starved; given up after a couple of minutes, when another forget is taking long.
    await client.query(`SET lock_timeout = '${Math.max(1, Math.round(wait.ms))}ms'`);
    try {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [FORGET_LOCK]);
    } catch (err) {
      // lock_not_available: the wait ran out. Anything else is a real failure.
      if ((err as { code?: string }).code === "55P03") throw new ForgetBusyError();
      throw err;
    }
    await client.query("SET lock_timeout = 0");
    const held: ForgetLockHeld = {
      async assertHeld() {
        const ok = !lost && (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND mode = 'ExclusiveLock' AND granted AND classid = 0 AND objid = $1 AND objsubid = 1", [FORGET_LOCK]).then((r) => r.rows[0].n > 0, () => false));
        if (!ok) throw new Error("The forget lock was lost before forgetting finished; run it again to finish");
      },
    };
    try {
      return await fn(held);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [FORGET_LOCK]).catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The advisory lock the album's own name passes hold (see `withNamePassesLock`). */
const NAME_PASSES_LOCK = 0x6e706173; // "npas"

/**
 * Run the album's own name passes — scrubbing withdrawn names, finishing forgets that waited for FORGET_KEY — unless
 * they are running already: at start-up and from the nightly job they could otherwise overlap, and forget the same
 * person twice. Tried, not waited for; false when another run holds it (this one is skipped, not queued). Held on a
 * connection of its own, so it goes with the connection however the run ends.
 */
export async function withNamePassesLock(fn: () => Promise<void>): Promise<boolean> {
  const client = new Client({ connectionString: env().DATABASE_URL });
  client.on("error", () => undefined);
  await client.connect();
  try {
    const { rows } = await client.query<{ got: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS got", [NAME_PASSES_LOCK]);
    if (!rows[0]?.got) return false;
    try {
      await fn();
      return true;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [NAME_PASSES_LOCK]).catch(() => undefined);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
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
