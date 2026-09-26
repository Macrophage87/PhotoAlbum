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

/**
 * Whether a forget that began after `since` is still under way. Read under a share lock on the one settings row,
 * inside the transaction that stores an answer: forgetting stamps that row before it does anything else, so it waits
 * for a write already under way, and a write that starts after it sees the stamp. While it runs, which photographs
 * it will touch is not known yet, so nothing is stored; once it has finished, the photographs it touched carry
 * `namesScrubbedAt` (see `unchangedSince`), and only answers about those are thrown away.
 */
export async function forgetUnderWay(tx: Prisma.TransactionClient, since: Date): Promise<boolean> {
  const rows = await tx.$queryRaw<{ lastForgetAt: Date | null; forgetFinishedAt: Date | null }[]>`SELECT "lastForgetAt", "forgetFinishedAt" FROM "AppSetting" WHERE id = 'app' FOR SHARE`;
  const started = rows[0]?.lastForgetAt;
  const finished = rows[0]?.forgetFinishedAt;
  return Boolean(started && started > since && (!finished || finished < started));
}
