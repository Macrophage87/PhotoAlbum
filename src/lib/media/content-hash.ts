import { db } from "@/lib/db";

/**
 * Room to wait for a connection and for the lock. Prisma's defaults (2 s to start, 5 s to finish) are short enough
 * that a busy pool would throw away a fully stored upload.
 */
const CLAIM_TX = { maxWait: 15_000, timeout: 15_000 };

/**
 * Give a stored file's hash to its row, unless a live row already has it — in which case that one's id comes back
 * and nothing is written.
 *
 * Looking and then writing are done under a transaction-scoped advisory lock on the hash, so two uploads of the same
 * bytes that overlap (the uploader sends three at once, and a family sends the same WhatsApp photos) cannot both see
 * no match and both be kept. A unique index would say the same thing more loudly, but the trash is allowed to hold a
 * folded copy that an admin may restore beside its keeper, and a restore must not be refused for it.
 */
export async function claimContentHash(photoId: string, contentHash: string, data: Record<string, unknown> = {}): Promise<{ id: string } | null> {
  const claim = () =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`photo-hash:${contentHash}`}))`;
      const already = await tx.photo.findFirst({ where: { contentHash, trashedAt: null, id: { not: photoId } }, orderBy: { createdAt: "asc" }, select: { id: true } });
      if (already) return already;
      await tx.photo.update({ where: { id: photoId }, data: { ...data, contentHash } });
      return null;
    }, CLAIM_TX);
  try {
    return await claim();
  } catch (err) {
    // A transaction that could not start or finish in time wrote nothing; one more go before the upload is given up.
    if ((err as { code?: string }).code !== "P2028") throw err;
    return claim();
  }
}
