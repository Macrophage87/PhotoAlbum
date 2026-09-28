import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { DOWNLOAD_ABANDONED_MS, PICK_AGAIN } from "@/lib/google/download-claim";
import { withLivePickerJob } from "@/lib/jobs/live";

/**
 * Longer than anything that makes a row before its file arrives can take: an upload is one request, a Takeout item a
 * few seconds, and a Picker download job expires after two hours and is retried once.
 */
export const STRANDED_AFTER_MS = 24 * 3600_000;

/**
 * Rows still waiting for a file ("pending") long after anything could still be bringing it: left by a request
 * that died with its process, or a worker restart mid-import. Each would otherwise be a "Processing…" tile for ever.
 * They are deleted with whatever part of a file reached their folder. Nothing with a file is touched here.
 *
 * A Google Photos row is the member's pick, so it is never deleted: one whose download never came (or died holding
 * it) is said to have failed, with what to do about it, and picking it again fetches it. Not while a download job
 * still names it, though — after a long outage the queue may simply not have reached it yet.
 */
export async function sweepStrandedUploads(now = new Date(), opts: { livePickerJobs?: (ids: string[]) => Promise<Set<string>> } = {}): Promise<number> {
  const livePickerJobs = opts.livePickerJobs ?? withLivePickerJob;
  const cutoff = new Date(now.getTime() - STRANDED_AFTER_MS);
  // updatedAt, not createdAt: a Picker row picked again is brought back to life (and touched) long after it was made.
  const stranded = { status: "PENDING" as const, originalPath: "pending", updatedAt: { lt: cutoff }, NOT: { sourceKind: "GOOGLE_PICKER" as const } };
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
  // Picker rows whose download never started, or died holding the row.
  const abandoned = new Date(now.getTime() - DOWNLOAD_ABANDONED_MS);
  const lostPicks = {
    sourceKind: "GOOGLE_PICKER" as const,
    originalPath: "pending",
    OR: [{ status: "PENDING" as const, updatedAt: { lt: cutoff } }, { status: "PROCESSING" as const, updatedAt: { lt: abandoned } }],
  };
  const picks = await db.photo.findMany({ where: lostPicks, select: { id: true } });
  const live = await livePickerJobs(picks.map((p) => p.id));
  const ids = picks.map((p) => p.id).filter((id) => !live.has(id));
  // Still lost when written: a download may have taken one since it was listed.
  const lost = ids.length
    ? await db.$executeRaw`
        UPDATE "Photo" SET status = 'FAILED', error = ${`The download from Google Photos was interrupted. ${PICK_AGAIN}`}, "updatedAt" = now()
        WHERE id = ANY(${ids}::text[]) AND "sourceKind" = 'GOOGLE_PICKER' AND "originalPath" = 'pending'
          AND ((status = 'PENDING' AND "updatedAt" < ${cutoff}) OR (status = 'PROCESSING' AND "updatedAt" < ${abandoned}))`
    : 0;
  if (lost) console.warn(`[worker] marked ${lost} interrupted Google Photos download(s) as failed`);
  return gone + lost;
}
