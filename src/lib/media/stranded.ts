import { db } from "@/lib/db";
import { storage } from "@/lib/storage";

/**
 * Longer than anything that makes a row before its file arrives can take: an upload is one request, a Takeout item a
 * few seconds, and a Picker download job expires after two hours and is retried once.
 */
export const STRANDED_AFTER_MS = 24 * 3600_000;

/**
 * Rows still waiting for a file ("pending") long after anything could still be bringing it: left by a request
 * that died with its process, or a worker restart mid-import. Each would otherwise be a "Processing…" tile for ever.
 * They are deleted with whatever part of a file reached their folder. Nothing with a file is touched here.
 */
export async function sweepStrandedUploads(now = new Date()): Promise<number> {
  const gone = await db.photo.findMany({
    where: { status: "PENDING", originalPath: "pending", createdAt: { lt: new Date(now.getTime() - STRANDED_AFTER_MS) } },
    select: { id: true },
  });
  for (const p of gone) {
    await storage().deletePrefix(`photos/${p.id}`).catch(() => undefined);
    await db.photo.delete({ where: { id: p.id } }).catch(() => undefined);
  }
  if (gone.length) console.warn(`[worker] removed ${gone.length} upload(s) whose file never arrived`);
  return gone.length;
}
