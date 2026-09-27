import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { liveImportKeys } from "@/lib/jobs/live";

/**
 * An uploaded track file no job has read in this long was left by an import that died with its worker: the job is
 * queued with no retry and expires after an hour, and only the job deletes its file. A Google export among them is
 * years of somebody's whereabouts, so it is not kept for ever by accident.
 */
export const IMPORT_ABANDONED_MS = 6 * 3600_000;

/**
 * Delete files under imports/ older than IMPORT_ABANDONED_MS that neither a track (a GPX or FIT file is kept with
 * the tracks it made) nor a live import job refers to. Nothing is deleted when the jobs cannot be read.
 */
export async function sweepImportFiles(now = new Date()): Promise<number> {
  const dir = storage().localPath?.("imports");
  if (!dir) return 0;
  const names = await readdir(dir).catch(() => [] as string[]);
  if (!names.length) return 0;
  const live = await liveImportKeys();
  if (!live) return 0;
  const cutoff = now.getTime() - IMPORT_ABANDONED_MS;
  let gone = 0;
  for (const name of names) {
    const key = `imports/${name}`;
    const s = await stat(path.join(dir, name)).catch(() => null);
    if (!s?.isFile() || s.mtimeMs >= cutoff || live.has(key)) continue;
    if (await db.track.findFirst({ where: { originalFile: key }, select: { id: true } })) continue;
    await storage().delete(key).then(() => gone++, (err) => console.error(`[sweep] could not delete ${key}`, err));
  }
  if (gone) console.warn(`[sweep] deleted ${gone} uploaded track file(s) whose import never finished`);
  return gone;
}

/** The hourly storage sweep. Each part stands alone, so one that fails does not keep the other from running. */
export async function sweepOrphanFiles(now = new Date()): Promise<void> {
  await sweepImportFiles(now).catch((err) => console.error("[sweep] track-file sweep failed", err));
}
