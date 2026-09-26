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
  const cutoff = new Date(now.getTime() - STRANDED_AFTER_MS);
  // updatedAt, not createdAt: a Picker row picked again is brought back to life (and touched) long after it was made.
  const stranded = { status: "PENDING" as const, originalPath: "pending", updatedAt: { lt: cutoff } };
  const candidates = await db.photo.findMany({ where: stranded, select: { id: true } });
  let gone = 0;
  for (const p of candidates) {
    // Only if it is still stranded now: a download may have claimed it since it was listed.
    const r = await db.photo.deleteMany({ where: { id: p.id, ...stranded } });
    if (r.count !== 1) continue;
    gone++;
    await storage().deletePrefix(`photos/${p.id}`).catch(() => undefined);
  }
  if (gone) console.warn(`[worker] removed ${gone} upload(s) whose file never arrived`);
  return gone;
}
