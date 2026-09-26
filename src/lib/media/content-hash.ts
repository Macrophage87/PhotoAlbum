import { db } from "@/lib/db";

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
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`photo-hash:${contentHash}`}))`;
    const already = await tx.photo.findFirst({ where: { contentHash, trashedAt: null, id: { not: photoId } }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (already) return already;
    await tx.photo.update({ where: { id: photoId }, data: { ...data, contentHash } });
    return null;
  });
}
